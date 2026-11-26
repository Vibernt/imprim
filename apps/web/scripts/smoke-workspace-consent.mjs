import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeServer } from './smoke-server.mjs';
import { forgetRealms } from '../../server/src/realms/realm.mjs';

export function workspaceConsentSmoke(browser) {
    test('phone consent approves and denies workspace-choice devices with JavaScript disabled', async t => {
        const server = await smokeServer(t), db = server.env.DB.db;
        db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
            UPDATE clients SET workspaces='shared',product='notes',agent_access='on',agent_registration_methods='["dynamic"]',
                agent_scope_catalogue='{"read":"Read notes"}',agent_resource_prefixes='["https://app.example/"]',
                agent_workspace_resources='["https://app.example/mcp"]' WHERE id='app';
            INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('ws_one','default','team','Design team',0),
                ('ws_two','default','team','Editorial team',0);
            INSERT INTO workspace_products(workspace_id,product,created) SELECT id,'notes',0 FROM workspaces;
            INSERT INTO workspace_members(workspace_id,user_id,role,created,updated)
                SELECT workspaces.id,users.id,'member',0,0 FROM workspaces,users`);
        forgetRealms(server.env);
        const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';
        const registration = await server.post('/register', { client_name: 'Test agent',
            grant_types: [deviceGrant], redirect_uris: ['http://127.0.0.1/callback'] });
        assert.equal(registration.status, 201, await registration.clone().text());
        const { client_id } = await registration.json();
        const context = server.track(await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark',
            viewport: { width: 375, height: 900 } }));
        await context.addCookies(server.cookies);
        const page = await context.newPage();
        const openConsent = async () => {
            const device = await server.call('/device_authorization', { method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id, scope: 'read', resource: 'https://app.example/mcp' }) });
            assert.equal(device.status, 200, await device.clone().text());
            const { user_code } = await device.json();
            const consent = await page.goto(server.origin + '/device?user_code=' + user_code);
            assert.equal(consent.status(), 200);
            await page.getByRole('button', { name: 'Not you?', exact: true }).waitFor();
            await page.waitForURL('**/agent/consent?request_id=*');
            assert.equal(await page.locator('script[src^="/fire/"], [style]').count(), 0);
            assert.equal(await page.locator('input[name="workspace_id"]:checked').count(), 0);
            const approve = page.getByRole('button', { name: 'Approve', exact: true });
            const deny = page.getByRole('button', { name: 'Deny', exact: true });
            const [primary, secondary, form] = await Promise.all([approve.boundingBox(), deny.boundingBox(),
                page.locator('form[action="/agent/consent"]').boundingBox()]);
            assert.ok(primary.y + primary.height <= secondary.y, 'primary button precedes the secondary button vertically');
            assert.ok(Math.abs(primary.width - form.width) < 1 && Math.abs(secondary.width - form.width) < 1, 'both buttons fill the form');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'consent fits the phone viewport');
        };
        await openConsent();
        await page.getByRole('button', { name: 'Approve', exact: true }).click();
        assert.equal(await page.locator('input[name="workspace_id"]:invalid').count(), 2);
        const first = page.getByRole('radio', { name: /Design team/ });
        await first.focus();
        await first.press('Space');
        await first.press('ArrowDown');
        assert.equal(await page.getByRole('radio', { name: /Editorial team/ }).isChecked(), true);
        await page.getByRole('button', { name: 'Approve', exact: true }).press('Enter');
        await page.getByRole('heading', { name: 'Agent connected' }).waitFor();
        assert.equal(db.prepare('SELECT workspace_id FROM agent_grants').get().workspace_id, 'ws_two');
        await openConsent();
        await page.getByRole('button', { name: 'Deny', exact: true }).press('Enter');
        await page.getByRole('heading', { name: 'Connection denied' }).waitFor();
        assert.equal(db.prepare('SELECT count(*) AS n FROM agent_grants').get().n, 1);
        await server.drain();
    });
}
