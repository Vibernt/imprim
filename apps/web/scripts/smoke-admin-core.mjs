import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../../server/src/lib/crypto.mjs';
import { ensureUser } from '../../server/src/services/admission.mjs';
import { issueSession } from '../../server/src/auth/session.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, exact: true });
const toast = (page, name) => page.getByText(name, { exact: true }).waitFor();
const tag = async (page, id, value) => {
    const input = page.locator('#' + id + '.fd-tag-input-field');
    await input.fill(value);
    await input.press('Enter');
};

async function go(page, server, path) {
    const response = await page.goto(server.origin + path);
    assert.equal(response.status(), 200, path);
    assert.match(response.headers()['content-security-policy'], /connect-src 'self'/);
    assert.equal(response.headers()['cache-control'], 'no-store');
}

async function fits(page) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), new URL(page.url()).pathname);
}

function clients(open) {
    test('Lit clients register and edit Fire fields, rotate a public client, and show each secret once', async t => {
        const { page, server } = await open(t, { role: 'realm', expectedBadRequest: '/admin/api/clients' });
        const db = server.env.DB.db;
        await go(page, server, '/admin/clients');
        await page.getByRole('table', { name: 'Clients' }).waitFor();
        await page.getByRole('link', { name: 'Register client', exact: true }).press('Enter');
        await page.locator('#f-id').fill('smoke-client');
        assert.equal(await page.locator('.fd-form-section').count(), 6);
        assert.equal(await page.locator('#f-dev').isChecked(), false);
        assert.equal(await page.locator('input[name="signup_policy"][value="invited"]').isChecked(), true);
        assert.equal(await page.locator('#f-agent_max_grant_days').inputValue(), '90');
        assert.equal(await page.locator('.fd-codefield textarea').count(), 1);
        assert.equal(await page.locator('#f-branding').isVisible(), false);
        await tag(page, 'f-redirect_uris', 'https://notes.example/cb');
        await page.locator('#f-backchannel_uri').fill('https://notes.example/logout');
        await page.getByRole('checkbox', { name: 'Passkey', exact: true }).check({ force: true }) // Fire's box covers the input; a click on it reaches the input through its label;
        await page.locator('input[name="workspaces"][value="shared"]').check();
        await page.locator('#f-product').fill('notes');
        await page.locator('#f-personal_workspaces').check({ force: true });
        await page.locator('#f-initiate_login_uri').fill('https://notes.example/login');

        await page.locator('#f-agent_access').check({ force: true });
        const pairs = page.locator('[data-im-control="agent_scope_catalogue"]');
        await pairs.getByRole('textbox', { name: 'Scope 1', exact: true }).fill('a=b');
        await pairs.getByRole('textbox', { name: /What people see at consent/ }).fill('Read notes');
        const refused = page.waitForResponse(r => r.url().endsWith('/admin/api/clients') && r.request().method() === 'POST');
        await button(page, 'Register client').click();
        assert.equal((await refused).status(), 400);
        await toast(page, 'Change could not be saved');
        assert.equal(await page.locator('#f-id').inputValue(), 'smoke-client');
        await tag(page, 'f-agent_resource_prefixes', 'https://notes.example/w/');
        await page.getByText('Override branding', { exact: true }).click();
        const brand = '<script>Smoke Notes</script>';
        await page.locator('#f-branding').fill(JSON.stringify({ name: brand }));
        await button(page, 'Register client').click();
        await heading(page, 'Copy the new client secret').waitFor();
        const secret = page.locator('.fd-secret');
        await button(page, 'Show client secret').click();
        const first = await secret.locator('.fd-secret-value').textContent();
        const saved = db.prepare("SELECT * FROM clients WHERE id='smoke-client'").get();
        assert.equal(saved.secret_hash, await sha256(first));
        assert.deepEqual(JSON.parse(saved.redirect_uris), ['https://notes.example/cb']);
        assert.deepEqual(JSON.parse(saved.sign_in_methods), ['email', 'passkey']);
        assert.deepEqual(JSON.parse(saved.agent_scope_catalogue), { 'a=b': 'Read notes' });
        assert.deepEqual([saved.workspaces, saved.product, saved.personal_workspaces, saved.initiate_login_uri],
            ['shared', 'notes', 'on', 'https://notes.example/login']);
        await button(page, 'Done').click();
        await heading(page, brand).waitFor();
        assert.equal(await page.locator('screen-admin-client-editor script').count(), 0);
        assert.equal(await secret.count(), 0);
        assert.equal(await page.locator('input[name="id"]').count(), 0);
        assert.equal(await page.locator('#f-personal_workspaces').isChecked(), true);
        assert.equal(await pairs.getByRole('textbox', { name: 'Scope 1', exact: true }).inputValue(), 'a=b');

        await page.locator('#f-agent_access').uncheck();
        await button(page, 'Save client').click();
        await toast(page, 'Client saved');
        assert.equal(db.prepare("SELECT agent_access FROM clients WHERE id='smoke-client'").get().agent_access, 'off');
        db.prepare("UPDATE clients SET secret_hash=NULL WHERE id='smoke-client'").run();
        const pendingId = crypto.randomUUID();
        db.prepare(`INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created,delivery_state,last_error)
            SELECT ?,'smoke-client',id,'session','https://notes.example/logout',?,'pending','Receiver busy'
            FROM users WHERE email='admin@example.com'`).run(pendingId, Date.now());
        await go(page, server, '/admin/clients/smoke-client');
        await heading(page, 'Back-channel delivery').waitFor();
        await page.getByRole('table', { name: 'Back-channel events' }).getByText('Receiver busy').waitFor();
        await button(page, 'Review secret rotation').click();
        const convert = page.getByRole('checkbox', { name: 'Make this public client confidential' });
        assert.equal(await convert.getAttribute('required'), '');
        await convert.check({ force: true });
        assert.equal(await button(page, 'Rotate secret').isDisabled(), true);
        await page.getByLabel('Type the client ID').fill('smoke-client');
        await button(page, 'Rotate secret').click();
        await heading(page, 'Copy the new client secret').waitFor();
        await button(page, 'Show client secret').click();
        assert.notEqual(await secret.locator('.fd-secret-value').textContent(), first);
        await button(page, 'Done').click();
        await secret.waitFor({ state: 'detached' });
        await page.reload();
        await heading(page, 'Client secret').waitFor();
        assert.equal(await secret.count(), 0);
        await fits(page);
    });
}

function usersAndAudit(open) {
    test('Lit users and audit support keyboard search, paging, session and account actions, and merge confirmation', async t => {
        const { page, server } = await open(t, { role: 'platform', width: 375, colorScheme: 'dark' });
        const db = server.env.DB.db;
        const source = await ensureUser(server.env, 'source@example.com');
        const survivor = await ensureUser(server.env, 'survivor@example.com');
        const { session } = await issueSession(server.env, source, 'email');
        const insertUser = db.prepare("INSERT INTO users(id,email,realm_id,created) VALUES(?,?,'default',0)");
        const insertAudit = db.prepare("INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES('browser_test','operator',?,'{}',?,'default')");
        for (let i = 0; i < 51; i++) {
            insertUser.run('page-' + i, 'paged-' + i + '@example.com');
            insertAudit.run(source.id, Date.now());
        }
        await go(page, server, '/admin/users?q=paged-');
        await page.getByRole('link', { name: 'Next page' }).click();
        await page.waitForFunction(() => document.querySelectorAll('screen-admin-users tbody tr').length === 1);
        assert.match(page.url(), /q=paged-.*before=/);
        const search = page.getByRole('searchbox', { name: 'Email or user ID' });
        await search.fill(source.email);
        await search.press('Enter');
        await page.getByRole('link', { name: source.email }).click();
        await heading(page, source.email).waitFor();
        await fits(page);

        const confirmUser = async name => {
            await button(page, name).click();
            const phrase = page.getByLabel('Type the user’s email');
            await page.waitForFunction(() => document.activeElement?.id === 'confirm-user-action');
            await phrase.fill(source.email);
        };
        await button(page, 'Revoke session ' + session.sid).click();
        await page.getByLabel('Type the user’s email').fill(source.email);
        await button(page, 'Revoke session').click();
        await toast(page, 'Session revoked');
        assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE sid=?').get(session.sid).n, 0);
        await confirmUser('Reset two-factor');
        await page.getByLabel('Reason').fill('Identity verified by call');
        await page.locator('form[data-fd-confirm-inline]').getByRole('button', { name: 'Reset two-factor' }).click();
        await toast(page, 'Two-factor reset');
        await confirmUser('Block user');
        await page.locator('form[data-fd-confirm-inline]').getByRole('button', { name: 'Block user' }).click();
        await toast(page, 'User blocked');
        await button(page, 'Unblock user').click();
        await toast(page, 'User unblocked');

        await page.getByLabel('Surviving user ID').fill(survivor.id);
        await button(page, 'Review merge').click();
        await heading(page, 'Merge ' + source.email + '?').waitFor();
        await page.locator('.fd-kv-item').filter({ hasText: survivor.email }).getByText(survivor.id, { exact: true }).waitFor();
        const confirm = page.getByLabel('Type the deleted user’s email');
        await confirm.fill(survivor.email);
        assert.equal(await button(page, 'Merge users').isDisabled(), true);
        await confirm.fill(source.email);
        await button(page, 'Merge users').click();
        await heading(page, survivor.email).waitFor();
        assert.equal(db.prepare('SELECT merged_into FROM users WHERE id=?').get(source.id).merged_into, survivor.id);
        await button(page, 'Delete user').click();
        const deletion = page.locator('form[data-fd-confirm-inline]');
        await deletion.getByLabel('Type the user’s email').fill(survivor.email);
        await deletion.getByRole('button', { name: 'Delete user' }).click();
        await toast(page, 'User deleted');
        assert.equal(db.prepare('SELECT status FROM users WHERE id=?').get(survivor.id).status, 'deleted');

        await go(page, server, '/admin/audit?target=' + encodeURIComponent(source.id));
        await page.getByRole('table', { name: 'Audit log' }).getByText('admin_merge').waitFor();
        await fits(page);
        await page.getByRole('link', { name: 'Next page' }).click();
        await page.waitForURL(/before=/);
        await page.getByRole('table', { name: 'Audit log' }).waitFor();
        await button(page, 'Actor').press('Enter');
        await page.getByLabel('Actor', { exact: true }).fill('operator');
        await button(page, 'Apply').click();
        await page.waitForURL(/actor=operator$/);
        await page.getByRole('table', { name: 'Audit log' }).waitFor();
        assert.equal(await page.getByRole('table', { name: 'Audit log' }).getByText('admin_merge').count(), 0);
        await button(page, 'Clear actor').click();
        await page.getByRole('table', { name: 'Audit log' }).getByText('admin_merge').waitFor();
    });
}

function services(open) {
    test('Lit service clients create, disable and delete with a public JWKS and a typed confirmation', async t => {
        const { page, server } = await open(t, { role: 'realm', width: 375, colorScheme: 'dark' });
        const db = server.env.DB.db;
        db.prepare("UPDATE clients SET agent_scope_catalogue=?,agent_resource_prefixes=? WHERE id='app'")
            .run('{"read":"Read"}', '["https://app.example/w/"]');
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const key = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'deployer' };
        await go(page, server, '/admin/services');
        await heading(page, 'No service clients yet').waitFor();
        await button(page, 'Create service client').click();
        await page.getByLabel('Service client ID').fill('deployer');
        await page.getByLabel('Name', { exact: true }).fill('Deployer');
        await page.getByLabel('App client ID').fill('app');
        await page.getByLabel('Owner email').fill('ops@example.com');
        await page.getByLabel('Public JWKS').fill(JSON.stringify({ keys: [key] }));
        await tag(page, 'service-scopes', 'read');
        await tag(page, 'service-prefixes', 'https://app.example/w/ops/');
        await button(page, 'Create service client').click();
        await toast(page, 'Service client created');
        await fits(page);
        await button(page, 'Edit deployer').click();
        await page.getByRole('radio', { name: 'Disabled', exact: true }).check();
        await button(page, 'Save service client').click();
        await toast(page, 'Service client saved');
        assert.equal(db.prepare("SELECT status FROM service_clients WHERE id='deployer'").get().status, 'disabled');
        await button(page, 'Delete deployer').click();
        assert.equal(await button(page, 'Delete service client').isDisabled(), true);
        await page.getByLabel('Type the service client ID').fill('deployer');
        await button(page, 'Delete service client').click();
        await heading(page, 'No service clients yet').waitFor();
        assert.equal(db.prepare("SELECT count(*) n FROM service_clients WHERE id='deployer'").get().n, 0);
    });
}

export function adminCoreSmoke(open) {
    clients(open);
    usersAndAudit(open);
    services(open);
}
