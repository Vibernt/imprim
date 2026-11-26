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

export async function stacked(table, action) {
    await action.waitFor();
    assert.equal(await table.getAttribute('data-stack'), '');
    assert.ok(await table.evaluate(el => {
        const scroll = el.parentElement;
        return getComputedStyle(el).display === 'block' && scroll.scrollWidth <= scroll.clientWidth;
    }), 'the phone table stacks without horizontal scrolling');
    const box = await action.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375, 'the action fits in the phone viewport');
    assert.equal(await action.getAttribute('data-size'), null, 'the action uses the normal Fire size');
}

function clients(open) {
    test('Lit clients register and edit Fire fields, rotate a public client, and show each secret once', async t => {
        const { page, server } = await open(t, { role: 'realm', expectedBadRequest: '/admin/api/clients/smoke-client/activate' });
        const db = server.env.DB.db;
        await go(page, server, '/admin/clients');
        await page.getByRole('table', { name: 'Clients' }).waitFor();
        await page.getByRole('link', { name: 'Register client', exact: true }).press('Enter');
        await page.getByLabel('Display name').fill('Smoke Notes');
        await page.locator('#f-id').fill('smoke-client');
        assert.equal(await page.locator('form.fd-form > .fd-form-section').count(), 2);
        for (const field of ['backchannel_uri', 'dev', 'product', 'agent_access', 'branding']) {
            assert.equal(await page.locator('#f-' + field).count(), 0, field);
        }
        await tag(page, 'f-redirect_uris', 'https://notes.example.com/cb');
        await page.getByRole('checkbox', { name: 'Passkey', exact: true }).check({ force: true });
        await button(page, 'Register client').click();
        await page.waitForURL('**/admin/clients/smoke-client');
        await heading(page, 'Smoke Notes').waitFor();
        await toast(page, 'Client draft created');
        assert.equal(db.prepare("SELECT count(*) AS n FROM clients WHERE id='smoke-client'").get().n, 0);
        await button(page, 'Copy client ID').waitFor();
        assert.equal(await page.locator('input[name="id"]').count(), 0);
        assert.equal(await page.locator('#f-product').isVisible(), false);
        assert.equal(await page.locator('[data-im-control="agent_scope_catalogue"]').isVisible(), false);
        await page.getByText('Enter a back-channel URL so Imprim can end app sessions.').waitFor();
        await page.locator('#f-backchannel_uri').fill('https://notes.example.com/logout');
        await page.locator('input[name="workspaces"][value="shared"]').check();
        await page.locator('#f-product').fill('notes');
        await page.locator('#f-personal_workspaces').check({ force: true });
        // A person clicks the switch itself (its label); a forced click on the hidden input is not what people do.
        await page.locator('label.fd-switch:has(#f-self_signup)').click();
        await page.getByText('Self-serve sign-up is on while Who can sign up is set to Invited only.').waitFor();
        await page.locator('label.fd-switch:has(#f-self_signup)').click();
        await page.locator('#f-initiate_login_uri').fill('https://notes.example.com/login');
        await page.locator('#f-listed').uncheck({ force: true });
        await page.getByLabel('App description').fill('Notes for this team');
        await page.getByText('Description by language', { exact: true }).click();
        await page.getByLabel('Français', { exact: true }).fill('Notes de cette équipe');

        await page.locator('#f-agent_access').check({ force: true });
        const pairs = page.locator('[data-im-control="agent_scope_catalogue"]');
        await pairs.getByRole('textbox', { name: 'Scope 1', exact: true }).fill('a=b');
        await pairs.getByRole('textbox', { name: /What people see at consent/ }).fill('Read notes');
        const refused = page.waitForResponse(r => r.url().endsWith('/admin/api/clients/smoke-client/activate') && r.request().method() === 'POST');
        await button(page, 'Activate client').click();
        assert.equal((await refused).status(), 400);
        // The refusal sits beside the sticky Save bar, not in a corner notice that would cover the Save button.
        await page.locator('.fd-callout[data-tone="danger"]').getByText('Change could not be saved', { exact: true }).waitFor();
        assert.equal(await page.locator('.fd-toaster .fd-toast[data-tone="danger"]').count(), 0);
        await tag(page, 'f-agent_resource_prefixes', 'https://notes.example.com/w/');
        const workspaceResources = page.locator('[data-im-control="agent_workspace_resources"]');
        await tag(page, 'f-agent_workspace_resources', 'https://notes.example.com/w/mcp');
        await page.locator('input[name="workspaces"][value="app"]').check();
        await workspaceResources.waitFor({ state: 'hidden' });
        await page.locator('input[name="workspaces"][value="shared"]').check();
        assert.equal(await page.locator('#f-product').inputValue(), 'notes');
        await workspaceResources.getByText('https://notes.example.com/w/mcp', { exact: true }).waitFor();

        await page.getByText('Override branding', { exact: true }).click();
        const brand = '<script>Smoke Notes</script>';
        await page.locator('#f-branding').fill(JSON.stringify({ name: brand, locale_copy: { fr: { signed_out: 'Au revoir' } } }));
        assert.equal(await button(page, 'Activate client').locator('..').evaluate(bar => getComputedStyle(bar).position), 'sticky');
        await button(page, 'Activate client').click();
        await heading(page, 'Copy the new client secret').waitFor();
        const secret = page.locator('.fd-secret');
        await button(page, 'Show client secret').click();
        const first = await secret.locator('.fd-secret-value').textContent();
        const saved = db.prepare("SELECT * FROM clients WHERE id='smoke-client'").get();
        assert.equal(saved.secret_hash, await sha256(first));
        assert.deepEqual(JSON.parse(saved.redirect_uris), ['https://notes.example.com/cb']);
        assert.deepEqual(JSON.parse(saved.sign_in_methods), ['email', 'passkey']);
        assert.deepEqual(JSON.parse(saved.agent_scope_catalogue), { 'a=b': 'Read notes' });
        assert.deepEqual(JSON.parse(saved.agent_workspace_resources), ['https://notes.example.com/w/mcp']);
        assert.deepEqual(JSON.parse(saved.branding), {
            name: brand, summary: 'Notes for this team', locale_copy: { fr: { signed_out: 'Au revoir', summary: 'Notes de cette équipe' } }
        });
        assert.equal(saved.listed, 0);
        assert.deepEqual([saved.workspaces, saved.product, saved.personal_workspaces, saved.initiate_login_uri],
            ['shared', 'notes', 'on', 'https://notes.example.com/login']);
        await button(page, 'Done').click();
        await heading(page, brand).waitFor();
        assert.equal(await page.locator('screen-admin-client-editor script').count(), 0);
        assert.equal(await secret.count(), 0);
        assert.equal(await page.locator('#f-personal_workspaces').isChecked(), true);
        assert.equal(await pairs.getByRole('textbox', { name: 'Scope 1', exact: true }).inputValue(), 'a=b');

        await page.locator('#f-agent_access').uncheck({ force: true });
        await pairs.waitFor({ state: 'hidden' });
        await button(page, 'Save client').click();
        await toast(page, 'Client saved');
        const disabled = db.prepare("SELECT agent_access,agent_scope_catalogue,agent_workspace_resources FROM clients WHERE id='smoke-client'").get();
        assert.deepEqual([disabled.agent_access, JSON.parse(disabled.agent_scope_catalogue), JSON.parse(disabled.agent_workspace_resources)],
            ['off', { 'a=b': 'Read notes' }, []]);
        db.prepare("UPDATE clients SET secret_hash=NULL WHERE id='smoke-client'").run();
        const pendingId = crypto.randomUUID();
        db.prepare(`INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created,delivery_state,last_error)
            SELECT ?,'smoke-client',id,'session','https://notes.example.com/logout',?,'pending','Receiver busy'
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
        db.prepare("UPDATE users SET display_name='Example Source',locale='es' WHERE id=?").run(source.id);
        const insertUser = db.prepare("INSERT INTO users(id,email,realm_id,created) VALUES(?,?,'default',0)");
        const insertAudit = db.prepare("INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES('browser_test','operator',?,'{}',?,'default')");
        for (let i = 0; i < 51; i++) {
            insertUser.run('page-' + i, 'paged-' + i + '@example.com');
            insertAudit.run(source.id, Date.now());
        }
        const longAuditDetail = JSON.stringify({ diagnostic: 'wrapped-audit-detail-'.repeat(20) });
        db.prepare("INSERT INTO audit(event,target,detail,created,realm_id) VALUES('browser_detail',?,?,?,'default')")
            .run(source.id, longAuditDetail, Date.now());
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
        const facts = page.locator('.fd-kv-item');
        assert.deepEqual(await facts.locator('.fd-kv-key').allTextContents(), [
            'Email', 'Name', 'Status', 'Verified', 'Created', 'Locale', 'Sign-in methods', 'Linked identities',
            'Two-step verification', 'Agent grants', 'User ID',
        ]);
        await facts.getByText('Example Source', { exact: true }).waitFor();
        await facts.getByText('es', { exact: true }).waitFor();
        assert.equal(await page.locator('details').filter({ hasText: 'Raw record' }).getAttribute('open'), null);
        assert.equal(await page.getByText('Merging deletes this user.', { exact: true }).isVisible(), true);
        const sessions = page.getByRole('table', { name: 'Sessions', exact: true });
        await sessions.getByText('Email link', { exact: true }).waitFor();
        assert.deepEqual(await sessions.locator('th').allTextContents(), ['Method', 'Started', 'Expires', 'Actions']);
        await stacked(sessions, button(page, 'Revoke session ' + session.sid));

        const confirmUser = async name => {
            await button(page, name).click();
            const phrase = page.getByLabel('Type the user’s email');
            await page.waitForFunction(() => document.activeElement?.id === 'confirm-user-action');
            await phrase.fill(source.email);
        };
        await button(page, 'Revoke session ' + session.sid).click();
        await page.getByLabel('Type the user’s email').fill(source.email);
        await page.locator('form[data-fd-confirm-inline]').getByRole('button', { name: 'Revoke session', exact: true }).click();
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
        const audit = page.getByRole('table', { name: 'Audit log' });
        await audit.getByText('Users merged', { exact: true }).waitFor();
        await audit.locator('[data-fd-tooltip="' + source.id + '"]').filter({ hasText: source.email }).first().waitFor();
        await audit.getByText('browser_test', { exact: true }).first().waitFor();
        const longDetail = audit.getByText(longAuditDetail, { exact: true });
        await longDetail.waitFor();
        assert.ok(await longDetail.evaluate(el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getClientRects().length > 1;
        }), 'long audit detail wraps at phone width');
        await fits(page);
        await page.getByRole('link', { name: 'Next page' }).click();
        await page.waitForURL(/before=/);
        await audit.waitFor();
        await page.getByRole('button', { name: /^Target:/ }).press('Enter');
        await page.getByLabel('Actor ID').fill('operator');
        await button(page, 'Apply').click();
        await page.waitForURL(/actor=operator$/);
        await audit.getByText('browser_test', { exact: true }).first().waitFor();
        assert.equal(await audit.getByText('Users merged', { exact: true }).count(), 0);
        await button(page, 'Clear subject').click();
        await audit.getByText('Users merged', { exact: true }).first().waitFor();
        await button(page, 'Event type').click();
        await page.locator('#audit-event').selectOption('admin_merge');
        await button(page, 'Apply').click();
        await page.waitForURL(/event=admin_merge$/);
        await audit.getByText('Users merged', { exact: true }).waitFor();
        // The filtered list replaces the previous rows when it arrives: wait for the old rows to leave, then count.
        await audit.getByText('browser_test', { exact: true }).first().waitFor({ state: 'detached' });
        assert.equal(await audit.getByText('browser_test', { exact: true }).count(), 0);
        const utc = new Date().toISOString().slice(0, 10);
        await button(page, 'Time range').click();
        await page.getByLabel('From (UTC)').fill(utc);
        await page.getByLabel('Through (UTC)').fill(utc);
        await button(page, 'Apply').click();
        await page.waitForURL(/from=.*&to=/);
        await audit.getByText('Users merged', { exact: true }).waitFor();
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
        assert.equal(await page.getByRole('table', { name: 'Service clients' }).locator('thead').count(), 0);
        const tabbar = page.locator('.fd-tabbar');
        await tabbar.getByRole('button', { name: 'More' }).click();
        const more = page.locator('#im-mobile-nav');
        await more.getByRole('link', { name: 'Services' }).waitFor();
        assert.equal(await more.getByRole('link', { name: 'Signing keys' }).count(), 0);
        assert.equal(await more.getByRole('link', { name: 'Realms' }).count(), 0);
        await page.keyboard.press('Escape');
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
        await stacked(page.getByRole('table', { name: 'Service clients' }), button(page, 'Edit deployer'));
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
