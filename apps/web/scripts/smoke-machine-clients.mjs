import test from 'node:test';
import assert from 'node:assert/strict';
import { seedMachineWorkspace, seededRequest, approvalPath } from '../../../tests/support/workspace-machines.mjs';
import { smokeServer } from './smoke-server.mjs';
import { forgetRealms } from '../../server/src/realms/realm.mjs';
import { detailConfirmation, dismissRowConfirm, enterConfirmationPhrase, postsTo } from './smoke-actions.mjs';

export function machineClientSmoke(browser, open) {
    test('phone machine approval works by keyboard with JavaScript turned off', async t => {
        const server = await smokeServer(t), db = server.env.DB.db;
        seedMachineWorkspace(db, db.prepare('SELECT id FROM users').get().id);
        forgetRealms(server.env);
        const context = server.track(await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark',
            viewport: { width: 375, height: 900 } }));
        await context.addCookies(server.cookies);
        const page = await context.newPage();
        for (const [decision, result] of [['Allow Editorial bot', 'Machine allowed.'], ['Deny', 'Request denied.']]) {
            const { request_id } = await seededRequest(server);
            const response = await page.goto(server.origin + approvalPath(request_id));
            assert.equal(response.status(), 200);
            await page.getByRole('heading', { name: 'Allow a machine to act for Editorial team?' }).waitFor();
            await page.getByText('Editorial tools', { exact: true }).first().waitFor();
            assert.equal(await page.locator('script[src^="/fire/"], [style]').count(), 0);
            const disclosure = page.locator('details.fd-disclosure');
            const thumbprints = disclosure.getByRole('heading', { name: 'Public key thumbprints' });
            assert.equal(await thumbprints.isVisible(), false);
            await disclosure.locator('summary').press('Space');
            await thumbprints.waitFor();
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
            workspace_id,accountable_user_id,expires_at,created,updated,last_used)
            VALUES(?,'default','app','Editorial bot',?,'{"keys":[]}','["read"]','["https://app.example/mcp"]',
                'workspace','ws_test',?,?,?,?,?)`).run(id, user.email, user.id, now + 60000, now, now, now);
        await page.goto(server.origin + (role ? '/admin/services' : '/account/agents'));
        const byButton = name => page.getByRole('button', { name, exact: true });
        const trigger = byButton('More actions for Editorial bot');
        const row = page.locator(role ? 'tbody tr:not(.fd-table-detail)' : 'li.fd-list-row').filter({ has: trigger });
        const disable = async () => {
            await trigger.press('Enter');
            await page.getByRole('menuitem', { name: 'Disable', exact: true }).press('Enter');
            return trigger;
        };
        if (role) {
            await row.getByText('Editorial team').waitFor();
            await byButton('More actions for Editorial bot').click();
            assert.deepEqual((await row.getByRole('menuitem').allTextContents()).map(text => text.trim()), ['Disable']);
            await page.keyboard.press('Escape');
        } else {
            await page.getByRole('heading', { name: 'Your machines' }).waitFor();
            await row.locator('.fd-list-desc').getByText(/Editorial team · Used /).waitFor();
            assert.equal(await row.locator('.fd-list-meta').count(), 0);
            const menu = byButton('More actions for Editorial bot');
            await menu.click();
            await page.getByRole('menuitem', { name: 'Renew' }).click();
            await page.getByText('Machine renewed', { exact: true }).waitFor();
            assert.ok(db.prepare('SELECT expires_at FROM service_clients WHERE id=?').get(id).expires_at > now + 60000);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        const disables = postsTo(page, role ? '/admin/api/services/' + id : '/v1/account/machine-clients/disable');
        const confirmation = role ? detailConfirmation(row) : row.locator(':scope > .fd-confirm-row');
        await dismissRowConfirm(page, confirmation, await disable(), disables);
        await dismissRowConfirm(page, confirmation, await disable(), disables, 'Escape');
        await disable();
        const confirm = await enterConfirmationPhrase(confirmation, role ? 'Type the service client ID' : 'Machine client ID',
            role ? 'Disable service client' : 'Disable machine', id, disables);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await confirm.click();
        await page.getByText(role ? 'Service client disabled' : 'Machine disabled', { exact: true }).waitFor();
        assert.equal(disables.length, 1);
        assert.equal(db.prepare('SELECT status FROM service_clients WHERE id=?').get(id).status, 'disabled');
        if (!role) {
            const disabled = page.locator('li.fd-list-row').filter({ has: page.getByText('Editorial bot', { exact: true }) });
            await disabled.locator('.fd-list-meta').getByText('Disabled', { exact: true }).waitFor();
            assert.doesNotMatch(await disabled.locator('.fd-list-desc').textContent(), / · Used /);
        }
    });
}
