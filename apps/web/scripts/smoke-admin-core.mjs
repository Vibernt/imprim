import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../../server/src/lib/crypto.mjs';
import { ensureUser } from '../../server/src/services/admission.mjs';
import { issueSession } from '../../server/src/auth/session.mjs';
import { detailConfirmation, dismissRowConfirm, enterConfirmationPhrase, openAction, finishHold, postsTo, undoHold } from './smoke-actions.mjs';

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

export async function stacked(table, action, size = null) {
    await action.waitFor();
    assert.equal(await table.getAttribute('data-stack'), '');
    assert.ok(await table.evaluate(el => {
        const scroll = el.parentElement;
        return getComputedStyle(el).display === 'block' && scroll.scrollWidth <= scroll.clientWidth;
    }), 'the phone table stacks without horizontal scrolling');
    const box = await action.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375, 'the action fits in the phone viewport');
    assert.equal(await action.getAttribute('data-size'), size, 'the action uses the expected Fire size');
}

function clients(open) {
    test('the audit console labels and filters sign-in refusals and shows the reason', async t => {
        const { page, server } = await open(t, { role: 'realm', width: 375 });
        const db = server.env.DB.db;
        db.exec(`UPDATE clients SET branding='{"name":"Notes"}' WHERE id='app';`);
        const detail = JSON.stringify({ reason: 'not_invited', method: 'email', client_id: 'app',
            email: 'p***@example.com', email_hash: await sha256('person@example.com') });
        db.prepare("INSERT INTO audit(event,target,detail,created,realm_id) VALUES('sign_in_refused','app',?,?,'default')")
            .run(detail, Date.now());
        await go(page, server, '/admin/audit');
        await page.getByRole('button', { name: 'Event type', exact: true }).click();
        await page.locator('#audit-event').selectOption({ label: 'Sign-in refused' });
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await page.waitForURL(url => url.searchParams.get('event') === 'sign_in_refused');
        const row = page.getByRole('row').filter({ hasText: 'not_invited' });
        await row.getByText('Sign-in refused', { exact: true }).waitFor();
        await row.getByText('Notes', { exact: true }).waitFor();
        await row.getByText(detail, { exact: true }).waitFor();
    });
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
        const rotations = postsTo(page, '/admin/api/clients/smoke-client/rotate-secret');
        await button(page, 'Review secret rotation').click();
        const rotation = page.locator('section[aria-labelledby="client-secret-title"] form.fd-confirm-inline');
        await rotation.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(rotations.length, 0);
        await page.waitForFunction(() => document.activeElement?.id === 'im-review-rotation');
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
        db.prepare("INSERT INTO recovery_codes(user_id,hash,created) VALUES(?,'smoke-unused-code',0)").run(source.id);
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
        const main = page.locator('.fd-split-main');
        const side = page.locator('.fd-split > .fd-panel');
        const facts = side.locator('.fd-kv-item');
        assert.deepEqual(await facts.locator('.fd-kv-key').allTextContents(), [
            'User ID', 'Name', 'Verified', 'Locale', 'Sign-in methods', 'Two-step verification', 'Agent grants',
        ]);
        assert.match(await page.locator('.fd-page-head-desc').textContent(), /^Created .* UTC$/);
        await page.locator('.fd-page-head-text .fd-status[data-variant="pill"]').filter({ hasText: 'Two-step verification on' }).waitFor();
        await side.getByRole('button', { name: 'Copy user id' }).waitFor({ state: 'attached' });
        assert.ok((await side.boundingBox()).y >= (await main.boundingBox()).y + (await main.boundingBox()).height);
        await facts.getByText('Example Source', { exact: true }).waitFor();
        await facts.getByText('es', { exact: true }).waitFor();
        assert.equal(await page.locator('details').filter({ hasText: 'Raw record' }).getAttribute('open'), null);
        await main.getByRole('heading', { name: 'Linked identities', exact: true }).waitFor();
        await main.getByText('No linked identities', { exact: true }).waitFor();
        const sessions = page.getByRole('table', { name: 'Sessions', exact: true });
        await sessions.getByText('Email link', { exact: true }).waitFor();
        assert.deepEqual((await sessions.locator('th').allTextContents()).map(text => text.trim()), ['Method', 'Started', 'Expires', 'Actions']);
        const sessionTrigger = sessions.getByRole('button', { name: /^More actions for Email link session/ });
        await stacked(sessions, sessionTrigger, 'sm');

        const chooseUser = (email, action) => openAction(page, 'More actions for ' + email, action);
        const confirmUser = async (name, field = 'confirm-user-action') => {
            await chooseUser(source.email, name);
            const phrase = page.getByLabel('Type the user’s email');
            await page.waitForFunction(id => document.activeElement?.id === id, field);
            await phrase.fill(source.email);
        };
        const sessionPosts = postsTo(page, '/admin/api/users/' + source.id + '/revoke-session');
        const revoke = async () => {
            await sessionTrigger.click();
            await sessions.getByRole('menuitem', { name: 'Revoke', exact: true }).click();
        };
        await revoke();
        const sessionRow = sessions.getByRole('row').filter({ hasText: 'Email link' });
        await undoHold(page, sessionRow, sessionTrigger, sessionPosts);
        assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE sid=?').get(session.sid).n, 1);
        await revoke();
        await finishHold(page);
        await toast(page, 'Session revoked');
        assert.deepEqual(sessionPosts, [{ sid: session.sid }]);
        assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE sid=?').get(session.sid).n, 0);
        const resetPosts = postsTo(page, '/admin/api/users/' + source.id + '/reset-mfa');
        await confirmUser('Reset two-step verification', 'reason');
        await main.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(resetPosts.length, 0);
        await page.waitForFunction(() => document.activeElement?.id === 'im-more-user-actions');
        await confirmUser('Reset two-step verification', 'reason');
        await page.getByLabel('Reason').fill('Identity verified by call');
        await page.locator('form[data-fd-confirm-inline]').getByRole('button', { name: 'Reset two-step verification' }).click();
        await toast(page, 'Two-step verification reset');
        const access = button(page, 'More actions for ' + source.email);
        await access.click();
        assert.equal(await page.getByRole('menuitem', { name: 'Reset two-step verification' }).count(), 0);
        await page.keyboard.press('Escape');
        const blocks = postsTo(page, '/admin/api/users/' + source.id + '/block');
        await confirmUser('Block user');
        await main.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(blocks.length, 0);
        await confirmUser('Block user');
        await page.locator('form[data-fd-confirm-inline]').getByRole('button', { name: 'Block user' }).click();
        await toast(page, 'User blocked');
        await chooseUser(source.email, 'Unblock user');
        await toast(page, 'User unblocked');

        await confirmUser('Merge into another user', 'surviving_id');
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
        const deletes = postsTo(page, '/admin/api/users/' + survivor.id + '/delete');
        await chooseUser(survivor.email, 'Delete user');
        await main.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(deletes.length, 0);
        await chooseUser(survivor.email, 'Delete user');
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
        await page.getByRole('textbox', { name: 'From (UTC)', exact: true }).fill(utc);
        await page.getByRole('textbox', { name: 'Through (UTC)', exact: true }).fill(utc);
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
        await more.getByRole('link', { name: 'Service clients' }).waitFor();
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
        const serviceTable = page.getByRole('table', { name: 'Service clients' });
        await stacked(serviceTable, button(serviceTable, 'More actions for Deployer'), 'sm');
        const serviceAction = action => openAction(serviceTable, 'More actions for Deployer', action);
        await serviceAction('Edit');
        await page.getByRole('radio', { name: 'Disabled', exact: true }).check();
        await button(page, 'Save service client').click();
        await toast(page, 'Service client saved');
        assert.equal(db.prepare("SELECT status FROM service_clients WHERE id='deployer'").get().status, 'disabled');
        const deletions = postsTo(page, '/admin/api/services/deployer/delete');
        const serviceRow = serviceTable.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Deployer', exact: true }) });
        const confirmation = detailConfirmation(serviceRow);
        await dismissRowConfirm(page, confirmation, await serviceAction('Delete'), deletions);
        await dismissRowConfirm(page, confirmation, await serviceAction('Delete'), deletions, 'Escape');
        await serviceAction('Delete');
        const confirm = await enterConfirmationPhrase(confirmation, 'Type the service client ID', 'Delete service client', 'deployer', deletions);
        await confirm.click();
        await heading(page, 'No service clients yet').waitFor();
        assert.equal(deletions.length, 1);
        assert.equal(db.prepare("SELECT count(*) n FROM service_clients WHERE id='deployer'").get().n, 0);
    });

    test('a stale service client deletion keeps the typed row question open with the Worker error', async t => {
        const path = '/admin/api/services/deployer/delete';
        const { page, server } = await open(t, { role: 'realm', expectedNotFound: [path] });
        const db = server.env.DB.db;
        db.prepare(`INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,created,updated)
            VALUES('deployer','default','app','Deployer','ops@example.com','{"keys":[]}','[]','[]',0,0)`).run();
        await go(page, server, '/admin/services');
        const table = page.getByRole('table', { name: 'Service clients' });
        const row = table.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Deployer', exact: true }) });
        const openQuestion = () => openAction(row, 'More actions for Deployer', 'Delete');
        const trigger = await openQuestion();
        const question = detailConfirmation(row);
        const posts = postsTo(page, path);
        const submit = await enterConfirmationPhrase(question, 'Type the service client ID', 'Delete service client', 'deployer', posts);
        db.prepare("DELETE FROM service_clients WHERE id='deployer'").run();

        const release = Promise.withResolvers();
        await page.route(url => url.pathname === path, async route => {
            await release.promise;
            await route.continue();
        });
        const response = page.waitForResponse(reply => new URL(reply.url()).pathname === path && reply.request().method() === 'POST');
        try {
            await submit.click();
            await question.and(page.locator('[aria-busy="true"]')).waitFor();
            assert.equal(await submit.getAttribute('aria-disabled'), 'true');
            await page.keyboard.press('Escape');
            await submit.press('Enter');
            assert.equal(await question.isVisible(), true);
        } finally {
            release.resolve();
        }
        assert.equal((await response).status(), 404);
        const error = question.getByRole('alert').filter({ hasText: 'Service client not found.' });
        await error.waitFor();
        assert.equal(await question.isVisible(), true);
        assert.equal(await row.isVisible(), true);
        assert.equal(await question.getByLabel('Type the service client ID', { exact: true }).inputValue(), 'deployer');
        await submit.locator('xpath=self::*[not(@aria-disabled="true")]').waitFor();
        assert.equal(await submit.evaluate(button => document.activeElement === button), true);
        assert.equal(posts.length, 1);
        await question.getByRole('button', { name: 'Cancel', exact: true }).click();
        await question.waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate(button => document.activeElement === button), true);
        assert.equal(posts.length, 1);
        await openQuestion();
        await question.waitFor();
        assert.equal(await error.isVisible(), false);
        assert.equal(await question.getByRole('textbox', { name: 'Type the service client ID', exact: true }).inputValue(), '');
        assert.equal(await submit.isDisabled(), true);
    });
}

export function adminCoreSmoke(open) {
    clients(open);
    usersAndAudit(open);
    services(open);
}
