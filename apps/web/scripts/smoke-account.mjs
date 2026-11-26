import test from 'node:test';
import assert from 'node:assert/strict';
import { currentStep, fromBase32, totpAt } from '../../../apps/server/src/auth/totp.mjs';

export function accountSmoke(open) {
    test('phone keyboard navigation opens the Lit account screens', async t => {
        const { page, server } = await open(t, { width: 375, colorScheme: 'dark' });
        await page.locator('.fd-tabbar [data-fd-mobile-nav]').click();
        const menu = page.locator('#im-mobile-nav');
        await menu.waitFor();
        await menu.getByRole('link', { name: 'Security', exact: true }).focus();
        await page.keyboard.press('Enter');
        const heading = page.locator('screen-security h1');
        await heading.waitFor();
        await page.waitForFunction(() => document.activeElement?.matches('screen-security h1'));
        assert.equal(await heading.textContent(), 'Security');
        assert.equal(page.url(), `${server.origin}/account/security`);
        await page.getByRole('heading', { name: 'Authenticator apps' }).waitFor();
        assert.equal(await page.locator('app-shell').count(), 1);
        await page.getByRole('link', { name: 'Manage remembered browsers' }).click();
        await page.getByRole('heading', { name: 'Remembered browsers' }).waitFor();
        await page.goto(`${server.origin}/account/agents`);
        await page.getByRole('heading', { name: 'Connected agents' }).waitFor();
        await page.getByText('No agents connected', { exact: true }).waitFor();
    });

    test('desktop Security enrols TOTP, shows codes once and opens a Fire password entry', async t => {
        const { page, server } = await open(t);
        const nav = page.locator('.fd-sidebar');
        await nav.getByRole('link', { name: 'Security', exact: true }).click();
        await page.getByRole('heading', { name: 'Authenticator apps', exact: true }).waitFor();
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

    test('desktop account access shows and removes a remembered browser and connected grant', async t => {
        const { page, server } = await open(t);
        const db = server.env.DB.db, user = db.prepare('SELECT id FROM users').get(), now = Date.now();
        db.prepare(`INSERT INTO trusted_devices(hash,user_id,client_id,name,created,last_used,expires_at)
            VALUES(?,?,'app','Test browser',?,?,?)`).run('b'.repeat(64), user.id, now, now, now + 60000);
        db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at,approved_device,approved_location)
            VALUES(?,'https://agent.example/meta','Test agent','metadata_document','app',?,'https://app.example/w/team/mcp','read','email',?,?,?,'Firefox on Linux','Paris, FR')`)
            .run(crypto.randomUUID(), user.id, now, now, now + 60000);
        const nav = page.locator('.fd-sidebar');
        await nav.getByRole('link', { name: 'Sessions and apps', exact: true }).click();
        await page.getByText('This browser', { exact: true }).waitFor();
        assert.equal(await nav.getByRole('link', { name: 'Sessions and apps', exact: true }).getAttribute('aria-current'), 'page');
        await page.getByRole('heading', { name: 'Signed-in sessions', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Apps', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Forget Test browser' }).click();
        await page.getByText('Browser forgotten', { exact: true }).waitFor();
        await page.getByText('No remembered browsers', { exact: true }).waitFor();
        await nav.getByRole('link', { name: 'Agents', exact: true }).click();
        await page.getByRole('heading', { name: 'Connected agents', exact: true }).waitFor();
        assert.equal(await nav.getByRole('link', { name: 'Agents', exact: true }).getAttribute('aria-current'), 'page');
        const row = page.locator('.fd-setting').filter({ hasText: 'Test agent' });
        await row.getByText('Approved on Firefox on Linux · Paris, FR', { exact: true }).waitFor();
        await row.getByRole('button', { name: 'Rename Test agent' }).press('Enter');
        const label = page.getByLabel('Connection name', { exact: true });
        await label.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'label');
        assert.equal(await row.getByLabel('Connection name').count(), 0);
        await label.fill('Unused name');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await label.waitFor({ state: 'detached' });
        await row.getByRole('button', { name: 'Rename Test agent' }).click();
        assert.equal(await label.inputValue(), '');
        await label.fill('  Desk connection  ');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await label.waitFor({ state: 'detached' });
        await row.locator('.fd-setting-title').getByText('Desk connection', { exact: true }).waitFor();
        await row.locator('.fd-setting-desc').getByText('Test agent', { exact: true }).waitFor();
        assert.equal(db.prepare('SELECT label FROM agent_grants').get().label, 'Desk connection');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'named connections fit the viewport');
        await row.getByRole('button', { name: 'Revoke Test agent' }).click();
        await page.getByText('Agent revoked', { exact: true }).waitFor();
        await row.getByText('Revoked', { exact: true }).waitFor();
        await server.drain();
    });
}
