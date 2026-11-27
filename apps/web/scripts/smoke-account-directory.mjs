import test from 'node:test';
import assert from 'node:assert/strict';
import { finishHold, postsTo, undoHold } from './smoke-actions.mjs';

export async function assertPhoneFit(page, labels) {
    const bar = page.locator('.fd-tabbar');
    await bar.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    assert.equal(await page.evaluate(() => innerWidth), 375);
    const tabs = bar.locator('.fd-tabbar-label');
    assert.deepEqual(await tabs.allTextContents(), labels);
    const measured = await tabs.evaluateAll(elements => elements.map(label => {
        const text = document.createRange();
        text.selectNodeContents(label);
        const bounds = text.getBoundingClientRect(), tab = label.closest('.fd-tabbar-item').getBoundingClientRect();
        return bounds.width > 0 && bounds.left >= Math.max(0, tab.left) - 1 && bounds.right <= Math.min(innerWidth, tab.right) + 1;
    }));
    assert.deepEqual(measured, labels.map(() => true), 'each full tab label fits in its own tab');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal document overflow');
}

export function accountDirectorySmoke(open) {
    test('phone Apps shows 0, 1 and 3 personal apps, shares local time with Sessions and fits in German', async t => {
        const zone = 'America/Los_Angeles';
        const { page, server } = await open(t, { width: 375, timezoneId: zone });
        const db = server.env.DB.db, user = db.prepare('SELECT id FROM users').get();
        const tabs = page.locator('.fd-tabbar'), grid = page.locator('screen-apps .fd-card-grid');
        const cards = grid.locator('a.fd-card[data-interactive]');
        await tabs.getByRole('link', { name: 'Apps', exact: true }).click();
        await page.locator('screen-apps .fd-empty').getByText('No apps yet', { exact: true }).waitFor();
        assert.equal(await grid.count(), 0);
        await page.getByText('Apps you can sign in to with this account.', { exact: true }).waitFor();
        assert.equal(await cards.count(), 0);

        const at = Date.UTC(2026, 0, 10, 1, 30), href = 'https://notes.example.com/sign-in';
        const brandApp = db.prepare('UPDATE clients SET branding=?,initiate_login_uri=? WHERE id=?');
        brandApp.run(JSON.stringify({ name: 'Notes', summary: 'Collect and share your notes.' }), href, 'app');
        db.prepare("UPDATE client_admissions SET last_signed_in=? WHERE client_id='app' AND user_id=?").run(at, user.id);
        const { sid } = db.prepare('SELECT sid FROM sessions WHERE user_id=?').get(user.id);
        db.prepare("INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('app',?,?,?)").run(user.id, sid, at);
        await page.reload();
        const card = cards.filter({ hasText: 'Notes' });
        const format = timeZone => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(at);
        await card.getByText(`Last signed in ${format(zone)}`, { exact: true }).waitFor();
        assert.equal(await card.getByText(`Last signed in ${format('UTC')}`, { exact: true }).count(), 0);
        assert.equal(await card.getAttribute('href'), href);
        assert.equal(await card.locator('.fd-tile').textContent(), 'N');
        assert.equal(await card.locator('.fd-card-arrow').count(), 1);
        await card.getByText('Collect and share your notes.', { exact: true }).waitFor();
        assert.equal(await cards.count(), 1);
        await tabs.getByRole('link', { name: 'Sessions', exact: true }).click();
        const sessionApps = page.getByRole('list', { name: 'Apps', exact: true });
        await sessionApps.getByText(`Signed in ${format(zone)}`, { exact: true }).waitFor();
        const menu = sessionApps.getByRole('button', { name: 'More actions for Notes' });
        const signOut = sessionApps.getByRole('menuitem', { name: 'Sign out of Notes', exact: true });
        await menu.press('Enter');
        assert.equal(await sessionApps.getByRole('menuitem', { name: 'Open Notes', exact: true }).getAttribute('href'), href);
        assert.equal(await signOut.getAttribute('data-tone'), 'danger');
        await page.keyboard.press('Escape');
        await signOut.waitFor({ state: 'hidden' });
        const count = () => db.prepare("SELECT COUNT(*) AS total FROM app_sessions WHERE client_id='app'").get().total;
        assert.equal(count(), 1);
        const posts = postsTo(page, '/v1/account/apps');
        await menu.click();
        await signOut.click();
        await undoHold(page, menu.locator('xpath=ancestor::li'), menu, posts);
        assert.equal(count(), 1);
        await menu.click();
        await signOut.click();
        await finishHold(page);
        await page.getByText('Signed out of the app', { exact: true }).waitFor();
        assert.deepEqual(posts, [{ client_id: 'app' }]);
        assert.equal(count(), 0);

        db.prepare("INSERT INTO clients(id,redirect_uris) VALUES('calendar','[]')").run();
        brandApp.run(JSON.stringify({ name: 'Tasks' }), 'https://tasks.example.com/sign-in', 'other');
        brandApp.run(JSON.stringify({ name: 'Calendar' }), 'https://calendar.example.com/sign-in', 'calendar');
        const admit = db.prepare('INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,?,?)');
        for (const id of ['other', 'calendar']) admit.run(user.id, id, at);
        await tabs.getByRole('link', { name: 'Apps', exact: true }).click();
        await cards.filter({ hasText: 'Calendar' }).getByText('Not signed in yet', { exact: true }).waitFor();
        await cards.filter({ hasText: 'Tasks' }).getByText('Not signed in yet', { exact: true }).waitFor();
        assert.equal(await cards.count(), 3);
        await assertPhoneFit(page, ['Profile', 'Apps', 'Security', 'Sessions', 'Agents']);
        db.prepare("UPDATE users SET locale='de' WHERE id=?").run(user.id);
        await page.reload();
        await page.locator('html[lang="de"]').waitFor();
        await assertPhoneFit(page, ['Profil', 'Apps', 'Sicherheit', 'Sitzungen', 'Agents']);
    });

    test('unknown account and admin documents show a 404 within their shell', async t => {
        const paths = ['/account/unknown/details', '/admin/unknown/details'];
        const { page, server } = await open(t, { role: 'platform', expectedNotFound: paths });
        for (const path of paths) {
            assert.equal((await page.goto(server.origin + path)).status(), 404);
            const shell = page.locator('app-shell');
            await shell.getByRole('heading', { name: 'Page not found', exact: true }).waitFor();
            assert.equal(await page.getByRole('heading', { name: 'Sign-in stopped' }).count(), 0);
            if (path.startsWith('/admin')) await shell.locator('.fd-sidebar').getByRole('link', { name: 'Signing keys' }).waitFor();
            await shell.locator('main').getByRole('link', { name: 'Profile', exact: true }).click();
            await page.locator('screen-profile #display_name').waitFor();
            assert.equal(new URL(page.url()).pathname, '/account');
        }
    });
}
