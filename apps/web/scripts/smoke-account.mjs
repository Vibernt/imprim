import test from 'node:test';
import assert from 'node:assert/strict';
import { currentStep, fromBase32, totpAt } from '../../../apps/server/src/auth/totp.mjs';
import { assertPhoneFit } from './smoke-account-directory.mjs';
import { dismissRowConfirm, focused, openAction, finishHold, postsTo, undoHold, dismissToasts } from './smoke-actions.mjs';
import { issueSession } from '../../server/src/auth/session.mjs';

export function accountSmoke(open) {
    test('phone keyboard navigation opens the Lit account screens', async t => {
        const { page, server } = await open(t, { width: 375, colorScheme: 'dark' });
        await assertPhoneFit(page, ['Profile', 'Apps', 'Security', 'Sessions', 'Agents']);
        await page.locator('.fd-topbar [data-fd-mobile-nav]').click();
        const menu = page.locator('#im-mobile-nav');
        await menu.waitFor();
        await menu.getByRole('link', { name: 'Sign out', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        const tabs = page.locator('.fd-tabbar');
        await tabs.getByRole('link', { name: 'Security', exact: true }).focus();
        await page.keyboard.press('Enter');
        const heading = page.locator('screen-security h1');
        await heading.waitFor();
        await page.waitForFunction(() => document.activeElement?.matches('screen-security h1'));
        assert.equal(await heading.textContent(), 'Security');
        assert.equal(page.url(), `${server.origin}/account/security`);
        await page.getByRole('heading', { name: 'Authenticator apps', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Passkeys', exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: 'Remembered browsers', exact: true }).count(), 0);
        assert.equal(await page.locator('app-shell').count(), 1);
        await tabs.getByRole('link', { name: 'Sessions', exact: true }).click();
        await page.getByRole('heading', { name: 'Remembered browsers', exact: true }).waitFor();
        await tabs.getByRole('link', { name: 'Agents', exact: true }).click();
        await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
        await page.getByText('No agents connected', { exact: true }).waitFor();
    });

    test('desktop Security enrols TOTP, shows codes once and opens a Fire password entry', async t => {
        const { page, server } = await open(t);
        const nav = page.locator('.fd-sidebar');
        await nav.getByRole('link', { name: 'Security', exact: true }).click();
        await page.getByRole('heading', { name: 'Authenticator apps', exact: true }).waitFor();
        await page.getByText('Two-step verification is off.', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Passkey name', { exact: true }).count(), 0);
        assert.equal(await nav.getByRole('link', { name: 'Security', exact: true }).getAttribute('aria-current'), 'page');
        assert.equal(await nav.locator('a[href="/admin"]').count(), 0);
        assert.match(await nav.locator('.fd-account-email').textContent(), /person@example\.com/);
        assert.equal(await page.locator('.fd-topbar a[href="/logout"]').count(), 1);
        await page.getByRole('button', { name: 'Add authenticator app', exact: true }).click();
        const qr = page.locator('.fd-qr img');
        await qr.waitFor();
        await page.waitForFunction(() => {
            const img = document.querySelector('.fd-qr img');
            return img?.complete && img.naturalWidth > 0;
        });
        const secret = page.locator('.fd-secret-value');
        const masked = await secret.textContent();
        await page.getByRole('button', { name: 'Show setup key' }).click();
        const revealed = await secret.textContent();
        assert.notEqual(revealed, masked);
        const otp = await totpAt(fromBase32(revealed), currentStep());
        await page.getByLabel('Name', { exact: true }).fill('Travel phone');
        await page.locator('#totp-code').pressSequentially(otp);
        await page.getByRole('button', { name: 'Add authenticator app', exact: true }).click();
        await page.locator('.fd-codes[data-ready]').waitFor();
        assert.equal(await page.locator('.fd-codes-item').count(), 10);
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await page.getByText('Travel phone', { exact: true }).waitFor();
        await page.getByText('Two-step verification is on.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'More actions for Travel phone' }).getAttribute('data-variant'), 'ghost');
        assert.equal(await page.locator('.fd-codes').count(), 0);
        await page.reload();
        const recovery = page.locator('section.fd-card').filter({ has: page.getByRole('heading', { name: 'Recovery codes', exact: true }) });
        const generate = recovery.locator('button[data-fd-confirm-row]');
        const recoveryPosts = postsTo(page, '/v1/account/mfa/recovery');
        const confirmation = recovery.locator('.fd-confirm-row');
        await generate.click();
        await dismissRowConfirm(page, confirmation, generate, recoveryPosts);
        await generate.click();
        await dismissRowConfirm(page, confirmation, generate, recoveryPosts, 'Escape');
        await generate.click();
        await confirmation.getByText('Your 10 unused codes stop working.', { exact: true }).waitFor();
        await confirmation.getByRole('button', { name: 'Generate new codes', exact: true }).click();
        await page.getByRole('heading', { name: 'New recovery codes', exact: true }).waitFor();
        assert.equal(recoveryPosts.length, 1);
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        assert.equal(await page.locator('.fd-codes').count(), 0);
        await page.getByRole('button', { name: 'Set a password', exact: true }).click();
        const password = page.getByLabel('New password');
        await password.fill('a strong test password phrase');
        await page.getByRole('button', { name: 'Show password' }).click();
        assert.equal(await password.getAttribute('type'), 'text');
        await page.getByRole('button', { name: 'Hide password' }).click();
        assert.equal(await password.getAttribute('type'), 'password');
        await page.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(await password.count(), 0);
        await server.drain();
    });

    test('Security gives disabled controls a reason and sends no mutation', async t => {
        const { page, server } = await open(t);
        await page.addInitScript(() => { Reflect.deleteProperty(window, 'PublicKeyCredential'); });
        await page.goto(server.origin + '/account/security');
        await page.locator('.fd-reason').getByText('This browser cannot add passkeys.').waitFor();
        const withoutSupport = page.getByRole('button', { name: 'Add passkey', exact: true });
        assert.equal(await withoutSupport.getAttribute('aria-disabled'), 'true');

        server.env.DB.db.exec("UPDATE users SET email_verified=0");
        await page.reload();
        const writes = [];
        page.on('request', request => {
            if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/v1/account/')) writes.push(request.url());
        });
        for (const label of ['Add authenticator app', 'Add passkey']) {
            const control = page.getByRole('button', { name: label, exact: true });
            await control.waitFor();
            assert.equal(await control.getAttribute('aria-disabled'), 'true');
            const reason = await control.getAttribute('aria-describedby');
            assert.equal(await page.locator(`#${reason} .fd-reason-why`).textContent(), 'Confirm your email first.');
            await control.press('Enter');
            await control.click({ force: true });
        }
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.deepEqual(writes, []);
    });

    test('a held sign-out still reaches the server when the page is left before it commits', async t => {
        const { page, server } = await open(t);
        const db = server.env.DB.db, user = db.prepare('SELECT * FROM users').get();
        const { session } = await issueSession(server.env, user, 'email');
        db.prepare('UPDATE sessions SET device=? WHERE sid=?').run('Firefox on Mac', session.sid);
        // Record how each account POST was sent: a commit on pagehide only arrives if fetch is told to keep it alive.
        // Playwright does not report a request the old document sends while it unloads, so the page records it.
        await page.evaluate(() => {
            const fetch = window.fetch;
            window.fetch = (input, init = {}) => {
                if (init.method === 'POST') {
                    const sent = JSON.parse(sessionStorage.getItem('im-sent') ?? '[]');
                    sent.push({ url: new URL(String(input), location.href).pathname, keepalive: init.keepalive === true });
                    sessionStorage.setItem('im-sent', JSON.stringify(sent));
                }
                return fetch(input, init);
            };
        });
        const posts = postsTo(page, '/v1/account/sessions');
        await page.locator('.fd-sidebar').getByRole('link', { name: 'Sessions', exact: true }).click();
        const firefox = page.getByRole('list', { name: 'Signed-in sessions' }).getByRole('listitem').filter({ hasText: 'Firefox on Mac' });
        await openAction(firefox, 'More actions for Firefox on Mac', 'Sign out Firefox on Mac');
        await page.locator('.fd-toast[data-front][data-held][data-state="open"]').getByRole('button', { name: 'Undo', exact: true }).waitFor();
        assert.equal(posts.length, 0, 'Nothing is sent while the action is held');
        assert.ok(db.prepare('SELECT 1 FROM sessions WHERE sid=?').get(session.sid));
        // Leave the page well inside the 5 seconds: Fire commits the held action on pagehide.
        await page.goto(server.origin + '/account/apps');
        for (let tries = 0; db.prepare('SELECT 1 FROM sessions WHERE sid=?').get(session.sid) && tries < 50; tries++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(db.prepare('SELECT 1 FROM sessions WHERE sid=?').get(session.sid), undefined, 'The session is signed out on the server');
        const sent = JSON.parse(await page.evaluate(() => sessionStorage.getItem('im-sent')) ?? '[]');
        assert.deepEqual(sent.filter(request => request.url.endsWith('/v1/account/sessions')),
            [{ url: '/v1/account/sessions', keepalive: true }]);
    });

    test('phone Sessions shows browsers and Agents separates editable connections from history', async t => {
        const { page, server } = await open(t, { width: 375 });
        const db = server.env.DB.db, user = db.prepare('SELECT * FROM users').get(), now = Date.now();
        for (const device of ['Firefox on Mac', 'Chrome on Linux']) {
            const { session } = await issueSession(server.env, user, 'email');
            db.prepare('UPDATE sessions SET device=? WHERE sid=?').run(device, session.sid);
        }
        db.prepare(`INSERT INTO trusted_devices(hash,user_id,client_id,name,created,last_used,expires_at)
            VALUES(?,?,'app','Test browser',?,?,?)`).run('b'.repeat(64), user.id, now, now, now + 60000);
        db.exec(`UPDATE clients SET agent_scope_catalogue='{"read":"Read workspace"}' WHERE id='app';
            INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('ws_smoke','default','team','Editorial team',0);
            INSERT INTO workspace_resources(resource,workspace_id,client_id,created,name)
            VALUES('https://app.example.com/w/team/mcp','ws_smoke','app',0,'Editorial tools')`);
        db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at,approved_device,approved_location)
            VALUES(?,'https://agent.example.com/meta','Test agent','metadata_document','app',?,'https://app.example.com/w/team/mcp','read','email',?,?,?,'Firefox on Linux','Paris, FR')`)
            .run(crypto.randomUUID(), user.id, now, now, now + 86400000);
        db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at)
            VALUES(?,'self-registered','Self-registered editor','dynamic','app',?,'https://app.example.com/editor','read','email',?,?,?)`)
            .run(crypto.randomUUID(), user.id, now, now, now + 86400000);
        db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at,workspace_id)
            VALUES(?,'https://agent.example.com/meta','Other agent','metadata_document','app',?,'https://app.example.com/mcp','read','email',?,?,?,'ws_smoke')`)
            .run(crypto.randomUUID(), user.id, now, now, now - 1);
        const nav = page.locator('.fd-tabbar');
        await nav.getByRole('link', { name: 'Sessions', exact: true }).click();
        const current = page.locator('.fd-list-row').filter({ hasText: 'This browser' });
        await current.locator('.fd-list-body .fd-badge').waitFor();
        assert.equal(await current.locator('.fd-list-trail, .fd-disclosure').count(), 0);
        assert.equal(await nav.getByRole('link', { name: 'Sessions', exact: true }).getAttribute('aria-current'), 'page');
        await page.getByRole('heading', { name: 'Signed-in sessions', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Apps', exact: true }).waitFor();
        const sessions = postsTo(page, '/v1/account/sessions');
        const firefox = page.getByRole('list', { name: 'Signed-in sessions' }).getByRole('listitem').filter({ hasText: 'Firefox on Mac' });
        const otherSessions = page.getByRole('button', { name: 'Sign out other sessions', exact: true });
        await otherSessions.click();
        await undoHold(page, firefox, otherSessions, sessions);
        const signOutOne = () => openAction(firefox, 'More actions for Firefox on Mac', 'Sign out Firefox on Mac');
        await undoHold(page, firefox, await signOutOne(), sessions);
        await signOutOne();
        await finishHold(page);
        await page.getByText('Session signed out', { exact: true }).waitFor();
        await firefox.waitFor({ state: 'detached' });
        assert.equal(sessions.length, 1);
        await otherSessions.click();
        await finishHold(page);
        await page.getByText('Signed out of other sessions', { exact: true }).waitFor();
        assert.equal(sessions[1].sid, 'others');
        // At 375px the toast stack sits over the next card's row actions until it times out or is dismissed.
        await dismissToasts(page);

        const browser = page.getByRole('list', { name: 'Remembered browsers' }).getByRole('listitem');
        const forget = () => openAction(browser, 'More actions for Test browser', 'Forget Test browser');
        const devices = postsTo(page, '/v1/account/devices');
        await undoHold(page, browser, await forget(), devices);
        await forget();
        await finishHold(page);
        await page.getByText('Browser forgotten', { exact: true }).waitFor();
        assert.deepEqual(devices, [{ device: 'b'.repeat(64) }]);
        await page.getByText('No remembered browsers', { exact: true }).waitFor();
        await nav.getByRole('link', { name: 'Agents', exact: true }).click();
        await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
        assert.equal(await nav.getByRole('link', { name: 'Agents', exact: true }).getAttribute('aria-current'), 'page');
        const row = page.locator('.fd-list-row').filter({ hasText: 'Test agent' });
        const unverified = page.locator('.fd-list-row').filter({ hasText: 'Self-registered editor' });
        await unverified.getByText('Unverified', { exact: true }).waitFor();
        // A connection's first token is issued at approval, so last_used is always set (never "Not used yet").
        await unverified.locator('.fd-list-meta').getByText(/^Used /).waitFor();
        await unverified.locator('summary').click();
        await unverified.getByText('https://app.example.com/editor', { exact: true }).waitFor();
        assert.equal(await unverified.locator('code').getByText('self-registered', { exact: true }).count(), 0);
        await unverified.locator('summary').click();
        const history = page.locator('.fd-accordion-item').filter({ hasText: 'Ended connections' });
        const summary = history.locator('.fd-accordion-trigger');
        await summary.getByText('Ended connections (1)', { exact: true }).waitFor();
        assert.equal(await history.getAttribute('open'), null);
        await summary.click();
        const ended = history.locator('.fd-list-row').filter({ hasText: 'Other agent' });
        await ended.getByText(/Expired /).waitFor();
        await ended.locator('.fd-list-desc').getByText(/Editorial team/).waitFor();
        assert.equal(await ended.locator('[data-fd-menu]').count(), 0);
        await row.locator('.fd-list-desc').getByText(/Editorial team · Firefox on Linux, Paris, FR/).waitFor();
        assert.equal(await row.getByText('Editorial tools', { exact: true }).isVisible(), false);
        await row.locator('summary').click();
        await row.getByText('Editorial tools', { exact: true }).waitFor();
        await row.getByText('agent.example.com', { exact: true }).waitFor();
        await row.getByText('https://app.example.com/w/team/mcp', { exact: true }).waitFor();
        await row.getByText('Read workspace', { exact: false }).waitFor();
        await row.getByText(/Approved .* on Firefox on Linux, Paris, FR/).waitFor();
        const menu = row.locator('[data-fd-menu]');
        await menu.press('Enter');
        await row.getByRole('menuitem', { name: 'Rename' }).press('Enter');
        const label = row.getByLabel('Connection name', { exact: true });
        await label.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'label');
        await label.fill('Unused name');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await label.waitFor({ state: 'detached' });
        await menu.click();
        await row.getByRole('menuitem', { name: 'Rename' }).click();
        assert.equal(await label.inputValue(), '');
        await label.fill('  Desk connection  ');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await label.waitFor({ state: 'detached' });
        await row.locator('.fd-list-title').getByText('Desk connection', { exact: true }).waitFor();
        assert.equal(db.prepare("SELECT label FROM agent_grants WHERE client_name='Test agent'").get().label, 'Desk connection');
        await assertPhoneFit(page, ['Profile', 'Apps', 'Security', 'Sessions', 'Agents']);
        const revoke = () => openAction(row, 'More actions for Desk connection', 'Revoke');
        const revokePosts = postsTo(page, '/v1/account/agents/revoke');
        const confirm = row.locator(':scope > .fd-confirm-row');
        await dismissRowConfirm(page, confirm, await revoke(), revokePosts);
        assert.equal(db.prepare("SELECT revoked_at FROM agent_grants WHERE client_name='Test agent'").get().revoked_at, null);
        const other = () => openAction(unverified, 'More actions for Self-registered editor', 'Revoke');
        await revoke();
        const otherTrigger = await other();
        await confirm.waitFor({ state: 'hidden' });
        await dismissRowConfirm(page, unverified.locator(':scope > .fd-confirm-row'), otherTrigger, revokePosts, 'Escape');
        await revoke();
        await confirm.getByText('Revoke access for Desk connection?', { exact: true }).waitFor();
        await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
        await page.getByText('Agent revoked', { exact: true }).waitFor();
        assert.equal(revokePosts.length, 1);
        await focused(page, unverified.locator('button[data-fd-menu]'));
        await summary.getByText('Ended connections (2)', { exact: true }).waitFor();
        if (await history.getAttribute('open') === null) await summary.click();
        const revoked = history.locator('.fd-list-row').filter({ hasText: 'Desk connection' });
        await revoked.getByText(/Revoked /).waitFor();
        assert.equal(await revoked.locator('[data-fd-menu]').count(), 0);
        await server.drain();
    });
}
