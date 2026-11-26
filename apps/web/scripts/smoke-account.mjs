import test from 'node:test';
import assert from 'node:assert/strict';
import { currentStep, fromBase32, totpAt } from '../../../apps/server/src/auth/totp.mjs';
import { assertPhoneFit } from './smoke-account-directory.mjs';

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
        await page.getByRole('heading', { name: 'Authenticator app', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Passkey', exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: 'Remembered browsers' }).count(), 0);
        assert.equal(await page.locator('app-shell').count(), 1);
        await tabs.getByRole('link', { name: 'Sessions', exact: true }).click();
        await page.getByRole('heading', { name: 'Remembered browsers' }).waitFor();
        await tabs.getByRole('link', { name: 'Agents', exact: true }).click();
        await page.getByRole('heading', { name: 'Connected agents' }).waitFor();
        await page.getByText('No agents connected', { exact: true }).waitFor();
    });

    test('desktop Security enrols TOTP, shows codes once and opens a Fire password entry', async t => {
        const { page, server } = await open(t);
        const nav = page.locator('.fd-sidebar');
        await nav.getByRole('link', { name: 'Security', exact: true }).click();
        await page.getByRole('heading', { name: 'Authenticator app', exact: true }).waitFor();
        await page.getByText('Two-step sign-in is off.', { exact: true }).waitFor();
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
        await page.getByText('Two-step sign-in is on.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Remove Travel phone' }).getAttribute('data-variant'), 'outline');
        assert.equal(await page.locator('.fd-codes').count(), 0);
        await page.reload();
        await page.getByRole('button', { name: 'Generate new codes' }).waitFor();
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

    test('phone Sessions shows browsers and Agents separates editable connections from history', async t => {
        const { page, server } = await open(t, { width: 375 });
        const db = server.env.DB.db, user = db.prepare('SELECT id FROM users').get(), now = Date.now();
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
        await page.getByText('This browser', { exact: true }).waitFor();
        assert.equal(await nav.getByRole('link', { name: 'Sessions', exact: true }).getAttribute('aria-current'), 'page');
        await page.getByRole('heading', { name: 'Signed-in sessions', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Apps', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Forget Test browser' }).click();
        await page.getByText('Browser forgotten', { exact: true }).waitFor();
        await page.getByText('No remembered browsers', { exact: true }).waitFor();
        await nav.getByRole('link', { name: 'Agents', exact: true }).click();
        await page.getByRole('heading', { name: 'Connected agents', exact: true }).waitFor();
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
        await row.getByRole('button', { name: 'More actions for Desk connection' }).click();
        await row.getByRole('menuitem', { name: 'Revoke' }).click();
        await row.getByText('Revoke access for Desk connection?', { exact: true }).waitFor();
        await row.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(db.prepare("SELECT revoked_at FROM agent_grants WHERE client_name='Test agent'").get().revoked_at, null);
        await menu.click();
        await row.getByRole('menuitem', { name: 'Revoke' }).click();
        await row.getByRole('button', { name: 'Revoke', exact: true }).click();
        await page.getByText('Agent revoked', { exact: true }).waitFor();
        await summary.getByText('Ended connections (2)', { exact: true }).waitFor();
        if (await history.getAttribute('open') === null) await summary.click();
        const revoked = history.locator('.fd-list-row').filter({ hasText: 'Desk connection' });
        await revoked.getByText(/Revoked /).waitFor();
        assert.equal(await revoked.locator('[data-fd-menu]').count(), 0);
        await server.drain();
    });
}
