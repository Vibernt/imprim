import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { smokeServer } from './smoke-server.mjs';
import { seedSignupRequest } from './signup-fixture.mjs';
import { detailConfirmation, dismissRowConfirm, dismissToasts, enterConfirmationPhrase, openAction, finishHold, postsTo, undoHold } from './smoke-actions.mjs';
import { ensureUser } from '../../server/src/services/admission.mjs';

const browser = await chromium.launch();
test.after(() => browser.close());

async function open(t, width = 1440, colorScheme = 'light', expectedConflict = null) {
    const server = await smokeServer(t, 'platform');
    const context = server.track(await browser.newContext({ viewport: { width, height: 900 }, colorScheme, locale: 'en-US' }));
    t.after(() => context.close());
    await context.addCookies(server.cookies);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        // A refusal the test provokes on purpose (a 409 from the endpoint it names) is not a failure.
        const conflict = expectedConflict?.test(message.location().url) && /status of 409/.test(message.text());
        if (!conflict) failures.push(message.text());
    });
    page.on('requestfailed', request => {
        if (request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(request.failure()?.errorText);
    });
    t.after(() => assert.deepEqual(failures, []));
    const go = path => page.goto(server.origin + path);
    const fits = name => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
        .then(result => assert.equal(result, true, `${name} fits ${width}px in ${colorScheme}`));
    // Notices only: audit rows now show the same words as readable event names ("Workspace created").
    const toast = name => page.locator('.fd-toast-title').getByText(name, { exact: true }).waitFor();
    return { page, server, go, fits, toast, context };
}

test('Workspaces uses Fire filters and form controls and closes only after the name is typed', async t => {
    const { page, server, go, fits, toast } = await open(t, 1440, 'light', /\/admin\/api\/workspaces\/[^/]+\/invite$/);
    const db = server.env.DB.db;
    db.prepare("UPDATE clients SET product='reports',workspaces='shared' WHERE id='other'").run();
    const seed = db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,status,created) VALUES(?,'default','team',?,?,0)");
    for (let i = 0; i < 51; i++) {
        const name = String(i).padStart(2, '0');
        seed.run('team-' + name, 'Team ' + name, 'active');
    }
    seed.run('closed', 'Old team', 'closed');
    await go('/admin/workspaces');
    await page.getByRole('table', { name: 'Workspaces' }).waitFor();
    await fits('Workspace list');
    await page.getByRole('button', { name: 'All statuses' }).click();
    await page.getByRole('menuitem', { name: 'Active' }).click();
    await page.getByRole('link', { name: 'Next page' }).click();
    await page.waitForURL('**/admin/workspaces?status=active&before=team-01');
    await page.getByRole('link', { name: 'Team 00' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Old team' }).count(), 0);
    await page.getByRole('button', { name: 'Clear status filter' }).click();
    await page.waitForURL('**/admin/workspaces');
    await page.getByRole('link', { name: 'Create workspace' }).click();
    await page.getByRole('heading', { name: 'Create workspace' }).waitFor();
    const products = page.getByLabel('Products', { exact: true });
    await products.fill('notes');
    await products.press('Enter');
    await page.getByLabel('Workspace name').fill('Test Team');
    await page.getByLabel('First owner email').fill('admin@example.com');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await toast('Workspace created');
    await page.getByRole('heading', { name: 'Test Team', exact: true }).waitFor();
    const id = db.prepare("SELECT id FROM workspaces WHERE name='Test Team'").get().id;
    const path = '/admin/api/workspaces/' + id;
    const main = page.locator('.fd-split-main');
    const details = page.locator('.fd-split > .fd-panel');
    assert.deepEqual(await main.locator('section.fd-card h2.fd-title').allTextContents(), ['Members', 'Products', 'Recent activity']);
    assert.deepEqual(await details.locator('.fd-kv-key').allTextContents(), ['Workspace ID', 'Kind', 'Status', 'Holds', 'Registered resources']);
    assert.equal(await page.locator('.fd-page-head-desc').textContent(), 'Team workspace');
    assert.equal(await page.locator('.fd-page-head .fd-status[data-variant="pill"]').textContent(), 'Active');
    assert.equal(await page.getByRole('button', { name: 'Send invitation' }).getAttribute('data-variant'), 'primary');
    assert.equal(await details.getByText('None', { exact: true }).count(), 2);
    await page.getByLabel('Product ID').fill('reports');
    await page.getByRole('button', { name: 'Add product' }).click();
    await toast('Products saved');
    const productPosts = postsTo(page, path + '/products');
    const removeProduct = page.getByRole('button', { name: 'Remove reports' });
    await removeProduct.click();
    await undoHold(page, main.locator('.fd-tag').filter({ has: removeProduct }), removeProduct, productPosts);
    await removeProduct.click();
    await finishHold(page);
    await removeProduct.waitFor({ state: 'detached' });
    assert.deepEqual(productPosts, [{ add: [], remove: ['reports'] }]);
    assert.equal(await page.locator('.fd-sidebar a[href="/admin/workspaces"]').getAttribute('aria-current'), 'page');
    assert.equal(db.prepare("SELECT count(*) AS n FROM workspace_products p JOIN workspaces w ON w.id=p.workspace_id WHERE w.name='Test Team' AND p.product='notes'").get().n, 1);
    const renamePosts = postsTo(page, path + '/rename');
    const rename = () => openAction(page, 'More actions for Test Team', 'Rename');
    await rename();
    await page.waitForFunction(() => document.activeElement?.id === 'workspace-name');
    await main.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(renamePosts.length, 0);
    await page.waitForFunction(() => document.activeElement?.id === 'im-more-workspace-actions');
    await rename();
    await page.getByLabel('Workspace name').fill('Renamed Team');
    await page.getByRole('button', { name: 'Save name' }).click();
    await toast('Name saved');
    await page.getByRole('heading', { name: 'Renamed Team', exact: true }).waitFor();
    await page.getByLabel('Email', { exact: true }).fill('join@example.net');
    await page.getByLabel('Invitation role').selectOption('viewer');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    // No app of the workspace's products has a sign-in address: the refusal is shown and nothing is saved.
    await page.getByText('No app in this workspace has a sign-in address yet. Ask your administrator.', { exact: true }).waitFor();
    assert.equal(db.prepare("SELECT count(*) AS n FROM workspace_invitations WHERE email='join@example.net'").get().n, 0);
    db.prepare("UPDATE clients SET product='notes',workspaces='shared',initiate_login_uri='https://notes.example.com/sign-in' WHERE id='app'").run();
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await toast('Invitation sent');
    const invitation = page.getByRole('table', { name: 'Open invitations' }).getByRole('row').filter({ hasText: 'join@example.net' });
    const revoke = () => openAction(invitation, 'More actions for invitation to join@example.net', 'Revoke');
    const revokePosts = postsTo(page, path + '/revoke-invitation');
    await undoHold(page, invitation, await revoke(), revokePosts);
    await revoke();
    await finishHold(page);
    await toast('Invitation revoked');
    assert.equal(revokePosts.length, 1);

    const member = await ensureUser(server.env, 'member@example.net');
    db.prepare("INSERT INTO workspace_members VALUES(?,?,'member',0,0)").run(id, member.id);
    db.prepare("INSERT INTO workspace_holds VALUES(?,'app','Balance due',0)").run(id);
    await page.reload();
    await details.getByText('Apps must release their holds first.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'More actions for Renamed Team' }).click();
    const blocked = page.getByRole('menuitem', { name: /^Close workspace/ });
    assert.equal(await blocked.getAttribute('aria-disabled'), 'true');
    await blocked.click({ force: true });
    assert.equal(new URL(page.url()).pathname, '/admin/workspaces/' + id);
    await page.keyboard.press('Escape');
    const row = page.getByRole('table', { name: 'Members' }).getByRole('row').filter({ hasText: member.email });
    const memberAction = action => openAction(row, 'More actions for ' + member.email, action);
    const rolePosts = postsTo(page, path + '/role');
    await memberAction('Change role');
    const role = page.locator('.fd-table-detail').getByLabel('Role for ' + member.email);
    await role.selectOption('viewer');
    await page.locator('.fd-table-detail').getByRole('button', { name: 'Cancel' }).click();
    await role.waitFor({ state: 'detached' });
    assert.equal(rolePosts.length, 0);
    await memberAction('Change role');
    await role.selectOption('viewer');
    await page.getByRole('button', { name: 'Save role' }).click();
    await toast('Role saved');
    await row.getByText('Viewer', { exact: true }).waitFor();
    const removePosts = postsTo(page, path + '/remove-member');
    await undoHold(page, row, await memberAction('Remove'), removePosts);
    await memberAction('Remove');
    await finishHold(page);
    await toast('Member removed');
    await row.waitFor({ state: 'detached' });
    assert.deepEqual(removePosts, [{ sub: member.id }]);
    db.prepare('DELETE FROM workspace_holds WHERE workspace_id=?').run(id);
    await page.reload();
    await openAction(page, 'More actions for Renamed Team', 'Close workspace');
    const close = page.getByRole('button', { name: 'Close workspace' });
    await close.waitFor();
    assert.equal(await close.isDisabled(), true);
    await page.locator('#workspace-confirm-name').fill('wrong');
    assert.equal(await close.isDisabled(), true);
    await page.locator('#workspace-confirm-name').fill('Renamed Team');
    await close.click();
    await toast('Workspace closed');
    await page.locator('.fd-page-head-text').getByText('Closed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save name' }).count(), 0);
    assert.equal(db.prepare("SELECT status FROM workspaces WHERE name='Renamed Team'").get().status, 'closed');
});

test('Branding lazy-loads Tweaks, restores the route look, uploads a logo and shows the saved email', async t => {
    const { page, go, fits, toast, context } = await open(t);
    const requests = [];
    page.on('request', req => requests.push(new URL(req.url()).pathname));
    await go('/admin/settings');
    await page.getByRole('heading', { name: 'Configuration', exact: true }).waitFor();
    await page.getByText('Workspace events', { exact: true }).waitFor();
    await page.getByText('Clients with events missing a back-channel URL', { exact: true }).waitFor();
    const rawConfiguration = page.locator('details').filter({ hasText: 'Raw configuration' });
    assert.equal(await rawConfiguration.getAttribute('open'), null);
    const nav = page.locator('.fd-sidebar');
    await nav.getByRole('link', { name: 'Branding' }).click();
    await page.getByRole('button', { name: 'Open tweaks' }).waitFor();
    assert.ok(!requests.some(path => /\/tweaks-[\w-]+\.js$/.test(path)), 'opening the editor did not load the panel');
    await page.getByRole('button', { name: 'Open tweaks' }).click();
    const panel = page.getByRole('dialog', { name: 'Tweaks' });
    await panel.waitFor();
    assert.ok(requests.some(path => /\/tweaks-[\w-]+\.js$/.test(path)), 'the panel has its own lazy module');
    assert.ok(await panel.locator('[data-tweak="palette"] button').count() > 10);
    await panel.locator('[data-palette="forest"]').click();
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'forest');
    await panel.getByRole('button', { name: 'Close tweaks' }).click();
    await nav.getByRole('link', { name: 'Configuration' }).click();
    await page.getByRole('heading', { name: 'Configuration', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'glacier');
    await nav.getByRole('link', { name: 'Branding' }).click();
    await page.getByRole('button', { name: 'Open tweaks' }).click();
    await panel.locator('[data-palette="forest"]').click();
    await panel.getByRole('button', { name: 'Close tweaks' }).click();
    await page.getByLabel('Texture character size').selectOption('10');
    await page.getByLabel('Texture character set').selectOption('dense');
    assert.equal(await page.locator('html').getAttribute('data-signature-cell'), '10');
    assert.equal(await page.locator('html').getAttribute('data-signature-ramp'), 'dense');
    await fits('Branding');
    const preview = page.locator('section.fd-card').filter({ has: page.getByRole('heading', { name: 'Sign-in preview' }) });
    assert.ok((await preview.boundingBox()).x > (await page.getByRole('heading', { name: 'Look', exact: true }).boundingBox()).x);
    assert.equal(await preview.locator('.fd-btn[data-variant="primary"]').isDisabled(), false);
    assert.equal(await preview.locator('.fd-screen').getAttribute('inert'), '');
    const saveBar = page.locator('.fd-form-actions[data-variant="sticky"]');
    await saveBar.getByRole('button', { name: 'Save branding' }).waitFor();
    assert.equal(await saveBar.count(), 1);
    const logosTab = page.getByRole('tab', { name: 'Logos', exact: true });
    await logosTab.click();
    assert.equal(await logosTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tab', { name: 'Look', exact: true }).getAttribute('aria-selected'), 'false');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XWQ8AAAAASUVORK5CYII=', 'base64');
    await page.getByLabel('Full logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
    await toast('Logo uploaded');
    await page.getByRole('tab', { name: 'Name and links', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Temporary name');
    await page.getByRole('tab', { name: 'Words', exact: true }).click();
    await saveBar.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('tab', { name: 'Name and links', exact: true }).click();
    assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), '');
    await page.getByLabel('Name', { exact: true }).fill('Studio');
    await preview.getByText('Sign in to Studio', { exact: true }).waitFor();
    // Discard resets the staged look and upload, so stage them again before saving the page.
    await page.getByRole('tab', { name: 'Look', exact: true }).click();
    await page.getByRole('button', { name: 'Open tweaks' }).click();
    await panel.locator('[data-palette="forest"]').click();
    await panel.getByRole('button', { name: 'Close tweaks' }).click();
    await page.getByRole('tab', { name: 'Logos', exact: true }).click();
    await page.getByLabel('Full logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
    await toast('Logo uploaded');
    await page.getByRole('button', { name: 'Save branding' }).click();
    await toast('Branding saved');
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'forest');
    await page.locator('.fd-sidebar .fd-brand').getByRole('img', { name: 'Studio' }).waitFor();
    assert.equal(await page.locator('.fd-topbar-title').textContent(), 'Vibernt');
    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Open sample email' }).click();
    const email = await popup;
    await email.getByRole('heading', { name: 'Sign in to Studio' }).waitFor();
    assert.match(await email.locator('img.im-logo-light').getAttribute('src'), /^data:image\/png;base64,/);
    assert.equal(await email.locator('a.im-button-text').getAttribute('href'), '#sample');
});

test('platform screens rotate and revoke signing keys and create, update and administer a realm', async t => {
    const { page, go, fits, toast } = await open(t);
    await go('/admin/keys');
    await page.getByRole('table', { name: 'Signing keys' }).waitFor();
    await fits('Signing keys');
    await page.getByRole('button', { name: 'Rotate now' }).click();
    await toast('Signing keys published');
    const published = page.getByRole('row').filter({ hasText: /ES256.*Published/s });
    await published.waitFor();
    await published.getByText('At next rotation', { exact: true }).waitFor();
    const kid = (await published.locator('td').first().textContent()).trim();
    const keyPosts = postsTo(page, '/admin/api/keys/' + encodeURIComponent(kid) + '/revoke');
    const revoke = () => openAction(published, 'More actions for published ES256 key', 'Revoke');
    const keyConfirm = detailConfirmation(published);
    assert.equal(await keyConfirm.isVisible(), false);
    await dismissRowConfirm(page, keyConfirm, await revoke(), keyPosts);
    await dismissRowConfirm(page, keyConfirm, await revoke(), keyPosts, 'Escape');
    await revoke();
    await keyConfirm.getByText('Only for a compromised key', { exact: true }).waitFor();
    const revokeKey = await enterConfirmationPhrase(keyConfirm, 'Type the key ID', 'Revoke key', kid, keyPosts);
    await revokeKey.click();
    await toast('Signing key revoked');
    assert.equal(keyPosts.length, 1);
    await page.locator('.fd-sidebar').getByRole('link', { name: 'Realms' }).click();
    await page.getByRole('table', { name: 'Realms' }).waitFor();
    await fits('Realms');
    await page.getByRole('link', { name: 'Create realm' }).click();
    await page.getByLabel('Realm ID').fill('studio');
    await page.getByLabel('Issuer').fill('https://studio.example');
    await page.getByLabel('Display name').fill('Studio');
    await page.getByRole('button', { name: 'Create realm' }).click();
    await toast('Realm created');
    await page.getByLabel('Display name').fill('Design Studio');
    await page.getByRole('button', { name: 'Save realm' }).click();
    await toast('Realm saved');
    await page.getByLabel('Administrator email').fill('owner@example.net');
    await page.getByRole('button', { name: 'Save role' }).click();
    await toast('Administrator role saved');
    const roster = page.getByRole('table', { name: 'Administrators' });
    const remove = () => openAction(roster, 'More actions for owner@example.net', 'Remove');
    const adminPosts = postsTo(page, '/admin/api/realms/studio/admins');
    const adminConfirm = detailConfirmation(roster.getByRole('row').filter({ has: page.getByRole('cell', { name: 'owner@example.net', exact: true }) }));
    await dismissRowConfirm(page, adminConfirm, await remove(), adminPosts);
    await dismissRowConfirm(page, adminConfirm, await remove(), adminPosts, 'Escape');
    await remove();
    assert.equal(await adminConfirm.locator('input').count(), 0);
    await adminConfirm.getByRole('button', { name: 'Remove administrator', exact: true }).click();
    await toast('Administrator removed');
    assert.deepEqual(adminPosts, [{ email: 'owner@example.net', role: null }]);
});

test('sign-up requests wait in a held toast and move approved requests out of Pending', async t => {
    const { page, go, server, toast, fits } = await open(t, 375, 'dark');
    const db = server.env.DB.db, { id, email, name } = seedSignupRequest(db);
    db.prepare("UPDATE signup_requests SET provider='github',provider_id='42',provider_login='applicant' WHERE id=?").run(id);
    await go('/admin/signups');
    const queue = page.getByRole('navigation', { name: 'Pending requests' });
    const item = queue.locator('.fd-queue-item').filter({ hasText: email });
    await item.getByText(name + ' · notes', { exact: true }).waitFor();
    await fits('Pending sign-up requests');
    const tabbar = page.getByRole('navigation', { name: 'Admin console' }).filter({ has: page.getByRole('button', { name: 'More' }) });
    assert.deepEqual(await tabbar.locator('.fd-tabbar-label').allTextContents(), ['Clients', 'Users', 'Workspaces', 'Sign-ups', 'More']);
    assert.equal(await tabbar.getByRole('link', { name: 'Sign-ups' }).getAttribute('aria-current'), 'page');
    const badge = page.locator('.fd-sidebar a[href="/admin/signups"] .fd-nav-badge');
    await badge.filter({ hasText: /^1$/ }).waitFor({ state: 'attached' });
    // On a phone the queue opens on the list; choosing a request shows its case.
    const heading = page.getByRole('heading', { name: 'Create ' + name + '?', exact: true });
    assert.equal(await heading.isVisible(), false);
    await item.click();
    await page.waitForURL('**/admin/signups?request=' + id);
    await heading.waitFor();
    await fits('Sign-up request case');
    const decision = page.locator('.fd-decision');
    await decision.locator('.fd-decision-facts li').filter({ hasText: 'Sign-up method' }).getByText('GitHub', { exact: true }).waitFor();
    await decision.getByText(email, { exact: true }).waitFor();
    const form = page.getByRole('form', { name: 'Decide the sign-up request' });
    const approve = form.getByRole('button', { name: 'Create workspace', exact: true });
    assert.equal(await approve.getAttribute('data-variant'), 'primary');
    assert.equal(await form.getByRole('button', { name: 'Decline', exact: true }).getAttribute('data-variant'), 'outline');
    const approvals = postsTo(page, '/admin/api/signups/' + id + '/approve');
    const declines = postsTo(page, '/admin/api/signups/' + id + '/decline');
    const hold = page.locator('.fd-toast[data-front][data-held][data-state="open"]');

    // Undo restores the case and sends nothing.
    await approve.click();
    await hold.getByText('Creating workspace', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'No requests waiting' }).waitFor();
    await hold.getByRole('button', { name: 'Undo', exact: true }).click();
    await heading.waitFor();
    assert.equal(approvals.length + declines.length, 0, 'Undo sends nothing');
    assert.equal(db.prepare('SELECT status FROM signup_requests WHERE id=?').get(id).status, 'pending');
    await hold.waitFor({ state: 'detached' });
    // The "Stopped" notice sits over the commit buttons on a phone; a person dismisses it or waits.
    await dismissToasts(page);

    // Leaving the page while an approval is held counts as Undo: nothing is sent (countdownOnly).
    await approve.click();
    await hold.getByText('Creating workspace', { exact: true }).waitFor();
    await go('/admin/clients');
    await page.getByRole('heading', { name: 'Clients', exact: true }).waitFor();
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(approvals.length + declines.length, 0, 'Leaving the page sends no decision');
    assert.equal(db.prepare('SELECT status FROM signup_requests WHERE id=?').get(id).status, 'pending');
    await go('/admin/signups?request=' + id);
    await heading.waitFor();

    await approve.click();
    await finishHold(page, 10000);
    await toast('Request approved');
    assert.equal(approvals.length, 1);
    assert.equal(declines.length, 0);
    await badge.filter({ hasText: /^0$/ }).waitFor({ state: 'attached' });
    await page.getByRole('heading', { name: 'No requests waiting' }).waitFor();
    await page.getByRole('button', { name: 'Pending', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Approved', exact: true }).click();
    const table = page.getByRole('table', { name: 'Sign-up requests' });
    const row = table.getByRole('row').filter({ hasText: email });
    await row.getByText('Approved', { exact: true }).waitFor();
    await row.getByText('GitHub', { exact: true }).waitFor();
    assert.equal(await table.getByRole('button').count(), 0, 'Other statuses are read-only');
    await fits('Approved sign-up requests');
    assert.equal(db.prepare('SELECT status FROM signup_requests WHERE id=?').get(id).status, 'approved');
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces WHERE name=?').get(name).n, 1);
});

test('admin screens fit a dark phone viewport, including the workspace-off state', async t => {
    const { page, go, fits, server } = await open(t, 375, 'dark');
    server.env.DB.db.exec("UPDATE realms SET config=json_remove(config,'$.workspaces')");
    for (const [path, visible] of [
        ['workspaces', 'Shared workspaces are off'], ['branding', 'Sign-in preview'],
        ['settings', 'Configuration'], ['keys', 'Signing keys'], ['realms', 'Vibernt']
    ]) {
        await go('/admin/' + path);
        await page.locator('main.fd-page').getByText(visible, { exact: true }).first().waitFor();
        await fits(path);
    }
    const bar = page.locator('.fd-tabbar');
    const more = bar.getByRole('button', { name: 'More' });
    assert.equal(await more.getAttribute('aria-current'), 'page');
    await more.press('Enter');
    const menu = page.locator('#im-mobile-nav');
    await menu.waitFor();
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    for (const name of ['Service clients', 'Profile', 'Signing keys', 'Realms', 'Sign out']) {
        await menu.getByRole('link', { name, exact: true }).waitFor();
    }
    assert.equal(await menu.getByRole('link', { name: 'Clients', exact: true }).count(), 0);
    await menu.getByRole('link', { name: 'Configuration', exact: true }).press('Enter');
    await page.getByRole('heading', { name: 'Configuration', exact: true }).waitFor();
});

test('the top bar menu keeps console destinations at tablet width', async t => {
    const { page, go } = await open(t, 768);
    await go('/admin/settings');
    const bar = page.locator('.fd-tabbar');
    assert.equal(await bar.isVisible(), false);
    await page.locator('.fd-topbar').getByRole('button', { name: 'Open menu' }).press('Enter');
    const menu = page.locator('#im-mobile-nav');
    await menu.getByRole('link', { name: 'Clients', exact: true }).press('Enter');
    await page.getByRole('heading', { name: 'Clients', exact: true }).waitFor();
});
