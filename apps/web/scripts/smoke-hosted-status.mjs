import assert from 'node:assert/strict';
import test from 'node:test';
import { challengeOf } from '../../server/src/lib/crypto.mjs';
import { forgetRealms } from '../../server/src/realms/realm.mjs';
import { addTeam, configureJoin } from '../../../tests/support/workspace-join.mjs';
import { smokeServer } from './smoke-server.mjs';

const notes = 'https://notes.example.com/start';
const tasks = 'https://tasks.example.com/start';
const callback = 'https://tasks.example.com/callback';

async function hosted(t, browser) {
    const server = await smokeServer(t), db = server.env.DB.db;
    const context = server.track(await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 900 } }));
    await context.addCookies(server.cookies);
    const page = await context.newPage();
    return { server, db, context, page, user: db.prepare('SELECT id,email FROM users').get() };
}

export function hostedStatusSmoke(browser) {
    test('hosted public and personal app rows and the one-app redirect', async t => {
        const { server, db, user, page } = await hosted(t, browser);
        const registerEntry = db.prepare('UPDATE clients SET initiate_login_uri=?,branding=?,listed=? WHERE id=?');
        registerEntry.run(notes, JSON.stringify({ name: 'Notes', summary: 'Write with your team' }), 1, 'app');
        registerEntry.run(tasks, JSON.stringify({ name: 'Tasks', summary: 'Plan with your team' }), 0, 'other');
        db.prepare("INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,'other',0)").run(user.id);
        await page.goto(server.origin + '/signed-out');
        const publicList = page.getByRole('list', { name: 'Sign in to an app' });
        assert.equal(await publicList.getByRole('link', { name: 'Notes' }).getAttribute('href'), notes);
        await publicList.getByText('Write with your team').waitFor();
        assert.equal(await publicList.getByRole('link').count(), 1);
        await page.goto(server.origin + '/signed-in');
        const personal = page.getByRole('list', { name: 'Your apps' });
        await personal.getByRole('link', { name: 'Notes' }).waitFor();
        assert.equal(await personal.getByRole('link', { name: 'Tasks' }).getAttribute('href'), tasks);
        db.exec("DELETE FROM client_admissions WHERE client_id='other'");
        // A browser does not route a redirect's target (Playwright), so read the skip without following it.
        const cookie = (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ');
        const skipped = await server.call('/signed-in', { headers: { cookie } });
        assert.equal(skipped.status, 303);
        assert.equal(skipped.headers.get('location'), notes);
    });

    test('workspace access refuses from the original browser and switches account with JavaScript off', async t => {
        const { server, db, user, context, page } = await hosted(t, browser);
        configureJoin(db);
        db.prepare("UPDATE clients SET signup_policy='invited',branding=?,redirect_uris=? WHERE id='other'")
            .run(JSON.stringify({ name: 'Tasks' }), JSON.stringify([callback]));
        addTeam(db, 'editorial', user.id, { name: 'Editorial team', role: 'member' });
        forgetRealms(server.env);
        const params = new URLSearchParams({ client_id: 'other', redirect_uri: callback, response_type: 'code',
            scope: 'openid email', state: 'test-state', nonce: 'test-nonce',
            code_challenge: await challengeOf('v'.repeat(43)), code_challenge_method: 'S256' });
        const authorization = server.origin + '/authorize?' + params;
        const openAccess = async () => {
            const response = await page.goto(authorization);
            assert.equal(response.status(), 200);
            await page.getByRole('heading', { name: 'Tasks isn’t in your workspace yet' }).waitFor();
            await page.getByText('Ask an owner or admin of Editorial team to add Tasks.').waitFor();
            assert.equal(await page.locator('script[src^="/fire/"], [style], style').count(), 0);
            return new URL(page.url()).searchParams.get('request_id');
        };
        const answered = await openAccess();
        // The app's callback host does not resolve here: observe the redirect's target instead of loading it.
        const returned = page.waitForRequest(request => request.url().startsWith(callback));
        await page.getByRole('button', { name: 'Back to Tasks' }).click();
        const back = new URL((await returned).url());
        await page.waitForURL(url => url.protocol === 'chrome-error:');
        assert.deepEqual(Object.fromEntries(back.searchParams), { error: 'access_denied', state: 'test-state', iss: server.env.ISSUER });
        assert.equal(db.prepare('SELECT id FROM auth_requests WHERE id=?').get(answered), undefined);
        const pending = await openAccess();
        await page.getByText(`Signed in as ${user.email}`, { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Not you?', exact: true }).click();
        await page.waitForURL(`**/login?request_id=${pending}`);
        await page.getByRole('heading', { name: 'Sign in to Tasks' }).waitFor();
        assert.equal(await page.locator('#request').getAttribute('data-request-id'), pending);
        assert.ok(!(await context.cookies()).some(cookie => cookie.name === '__Host-vi_session'));
        assert.ok(db.prepare('SELECT id FROM auth_requests WHERE id=?').get(pending));
        await server.drain();
    });
}
