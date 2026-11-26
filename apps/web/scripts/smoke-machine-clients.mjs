import test from 'node:test';
import assert from 'node:assert/strict';
import { seedMachineWorkspace, seededRequest, approvalPath } from '../../../tests/support/workspace-machines.mjs';
import { smokeServer } from './smoke-server.mjs';
import { forgetRealms } from '../../server/src/realms/realm.mjs';

export function machineClientSmoke(browser, open) {
    test('phone machine approval works by keyboard with JavaScript turned off', async t => {
        const server = await smokeServer(t), db = server.env.DB.db;
        seedMachineWorkspace(db, db.prepare('SELECT id FROM users').get().id);
        forgetRealms(server.env);
        const context = server.track(await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark',
            viewport: { width: 375, height: 900 } }));
        await context.addCookies(server.cookies);
        const page = await context.newPage();
        for (const [decision, result] of [['Approve', 'Machine allowed.'], ['Deny', 'Request denied.']]) {
            const { request_id } = await seededRequest(server);
            const response = await page.goto(server.origin + approvalPath(request_id));
            assert.equal(response.status(), 200);
            await page.getByRole('heading', { name: 'Allow a machine to act for Editorial team?' }).waitFor();
            await page.getByText('Editorial tools', { exact: true }).waitFor();
            assert.equal(await page.locator('script[src^="/fire/"], [style]').count(), 0);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.getByRole('button', { name: decision, exact: true }).press('Enter');
            await page.getByRole('heading', { name: result, exact: true }).waitFor();
        }
        assert.equal(db.prepare('SELECT count(*) n FROM service_clients').get().n, 1);
        await server.drain();
    });

    for (const role of [null, 'realm']) test(`workspace machine controls in the ${role ? 'admin' : 'account'} console`, async t => {
        const { server, page } = await open(t, { role, width: 375 });
        const db = server.env.DB.db, user = db.prepare('SELECT id,email FROM users').get(), now = Date.now();
        seedMachineWorkspace(db, user.id);
        forgetRealms(server.env);
        const id = 'ws-' + '1'.repeat(20);
        db.prepare(`INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,source,
            workspace_id,accountable_user_id,expires_at,created,updated)
            VALUES(?,'default','app','Editorial bot',?,'{"keys":[]}','["read"]','["https://app.example/mcp"]',
                'workspace','ws_test',?,?,?,?)`).run(id, user.email, user.id, now + 60000, now, now);
        await page.goto(server.origin + (role ? '/admin/services' : '/account/agents'));
        const byButton = name => page.getByRole('button', { name, exact: true });
        if (role) {
            const row = page.getByRole('row').filter({ hasText: 'Editorial bot' });
            await row.getByText('Editorial team').waitFor();
            assert.equal(await row.getByRole('button', { name: 'Edit ' + id }).count(), 0);
            assert.equal(await row.getByRole('button', { name: 'Delete ' + id }).count(), 0);
            await byButton('Disable ' + id).click();
        } else {
            await page.getByRole('heading', { name: 'Machines you’re accountable for' }).waitFor();
            await byButton('Renew Editorial bot').click();
            await page.getByText('Machine renewed', { exact: true }).waitFor();
            assert.ok(db.prepare('SELECT expires_at FROM service_clients WHERE id=?').get(id).expires_at > now + 60000);
            await byButton('Disable Editorial bot').press('Enter');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        const confirm = byButton(role ? 'Disable service client' : 'Disable machine');
        assert.equal(await confirm.isDisabled(), true);
        const field = page.getByLabel(role ? 'Type the service client ID' : 'Machine client ID', { exact: true });
        await field.fill(id.slice(0, -1));
        assert.equal(await confirm.isDisabled(), true);
        await field.fill(id);
        await confirm.click();
        await page.getByText(role ? 'Service client disabled' : 'Machine disabled', { exact: true }).waitFor();
        assert.equal(db.prepare('SELECT status FROM service_clients WHERE id=?').get(id).status, 'disabled');
    });
}
