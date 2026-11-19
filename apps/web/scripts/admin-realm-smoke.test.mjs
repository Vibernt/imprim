import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { smokeServer } from './smoke-server.mjs';
import { seedSignupRequest } from './signup-fixture.mjs';

const browser = await chromium.launch();
test.after(() => browser.close());

async function open(t, width = 1440, colorScheme = 'light') {
    const server = await smokeServer(t, 'platform');
    const context = server.track(await browser.newContext({ viewport: { width, height: 900 }, colorScheme, locale: 'en-US' }));
    t.after(() => context.close());
    await context.addCookies(server.cookies);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
    page.on('requestfailed', request => {
        if (request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(request.failure()?.errorText);
    });
    t.after(() => assert.deepEqual(failures, []));
    const go = path => page.goto(server.origin + path);
    const fits = name => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
        .then(result => assert.equal(result, true, `${name} fits ${width}px in ${colorScheme}`));
    const toast = name => page.getByText(name, { exact: true }).waitFor();
    return { page, server, go, fits, toast, context };
}

test('Workspaces uses Fire filters and form controls and closes only after the name is typed', async t => {
    const { page, server, go, fits, toast } = await open(t);
    const db = server.env.DB.db;
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
    assert.equal(await page.locator('.fd-sidebar a[href="/admin/workspaces"]').getAttribute('aria-current'), 'page');
    assert.equal(db.prepare("SELECT count(*) AS n FROM workspace_products p JOIN workspaces w ON w.id=p.workspace_id WHERE w.name='Test Team' AND p.product='notes'").get().n, 1);
    await page.getByLabel('Workspace name').fill('Renamed Team');
    await page.getByRole('button', { name: 'Save name' }).click();
    await toast('Name saved');
    await page.getByRole('heading', { name: 'Renamed Team', exact: true }).waitFor();
    await page.getByLabel('Email', { exact: true }).fill('join@example.net');
    await page.getByLabel('Invitation role').selectOption('viewer');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await toast('Invitation sent');
    await page.getByRole('button', { name: 'Revoke invitation for join@example.net' }).click();
    await toast('Invitation revoked');
    await page.getByRole('link', { name: 'Review closure' }).click();
    const close = page.getByRole('button', { name: 'Close workspace' });
    await close.waitFor();
    assert.equal(await close.isDisabled(), true);
    await page.locator('#workspace-confirm-name').fill('wrong');
    assert.equal(await close.isDisabled(), true);
    await page.locator('#workspace-confirm-name').fill('Renamed Team');
    await close.click();
    await toast('Workspace closed');
    await page.getByText('Closed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save name' }).count(), 0);
    assert.equal(db.prepare("SELECT status FROM workspaces WHERE name='Renamed Team'").get().status, 'closed');
});

test('Branding lazy-loads Tweaks, restores the route look, uploads a logo and shows the saved email', async t => {
    const { page, go, fits, toast, context } = await open(t);
    const requests = [];
    page.on('request', req => requests.push(new URL(req.url()).pathname));
    await go('/admin/settings');
    await page.getByRole('heading', { name: 'Full configuration' }).waitFor();
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
    await nav.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('heading', { name: 'Full configuration' }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'glacier');
    await nav.getByRole('link', { name: 'Branding' }).click();
    await page.getByRole('button', { name: 'Open tweaks' }).click();
    await panel.locator('[data-palette="forest"]').click();
    await panel.getByRole('button', { name: 'Close tweaks' }).click();
    await page.getByLabel('Signature cell size').selectOption('10');
    await page.getByLabel('Signature ramp').selectOption('dense');
    assert.equal(await page.locator('html').getAttribute('data-signature-cell'), '10');
    assert.equal(await page.locator('html').getAttribute('data-signature-ramp'), 'dense');
    await fits('Branding');
    await page.getByRole('button', { name: 'Logos', exact: true }).click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XWQ8AAAAASUVORK5CYII=', 'base64');
    await page.getByLabel('Full logo', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
    await toast('Logo uploaded');
    await page.getByRole('button', { name: 'Name and links', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Studio');
    await page.getByRole('button', { name: 'Save branding' }).click();
    await toast('Branding saved');
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'forest');
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
    const kid = (await published.locator('td').first().textContent()).trim();
    await published.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.getByLabel('Type ' + kid + ' to confirm').fill(kid);
    await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
    await toast('Signing key revoked');
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
    await page.getByRole('button', { name: 'Remove administrator owner@example.net' }).click();
    await page.getByLabel('Type owner@example.net to confirm').fill('owner@example.net');
    await page.getByRole('button', { name: 'Remove administrator', exact: true }).click();
    await toast('Administrator removed');
});

test('sign-up requests require inline confirmation and move approved requests out of Pending', async t => {
    const { page, go, server, toast, fits } = await open(t, 375, 'dark');
    const db = server.env.DB.db, { id, email, name } = seedSignupRequest(db);
    await go('/admin/signups');
    const table = page.getByRole('table', { name: 'Sign-up requests' });
    const row = table.getByRole('row').filter({ hasText: email });
    await row.getByText(name, { exact: true }).waitFor();
    await fits('Pending sign-up requests');
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    const confirmation = table.locator('.fd-confirm-inline');
    await confirmation.waitFor();
    const confirm = confirmation.getByRole('button', { name: 'Approve request' });
    assert.equal(await confirm.isDisabled(), true);
    const input = confirmation.getByRole('textbox', { name: 'Type the email to confirm' });
    assert.ok(await input.evaluate(element => element === document.activeElement));
    await input.fill('wrong@example.net');
    assert.equal(await confirm.isDisabled(), true);
    await input.fill(email);
    await confirm.click();
    await toast('Request approved');
    await page.getByRole('heading', { name: 'No requests in this status' }).waitFor();
    await page.getByRole('button', { name: 'Pending', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Approved', exact: true }).click();
    await row.getByText('Approved', { exact: true }).waitFor();
    await fits('Approved sign-up requests');
    assert.equal(db.prepare('SELECT status FROM signup_requests WHERE id=?').get(id).status, 'approved');
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces WHERE name=?').get(name).n, 1);
});

test('admin screens fit a dark phone viewport, including the workspace-off state', async t => {
    const { page, go, fits, server } = await open(t, 375, 'dark');
    server.env.DB.db.exec("UPDATE realms SET config=json_remove(config,'$.workspaces')");
    for (const [path, visible] of [
        ['workspaces', 'Shared workspaces are off'], ['branding', 'Sign-in preview'],
        ['settings', 'Full configuration'], ['keys', 'Emergency revocation'], ['realms', 'Vibernt']
    ]) {
        await go('/admin/' + path);
        await page.locator('main.fd-page').getByText(visible, { exact: true }).first().waitFor();
        await fits(path);
    }
    await page.locator('.fd-tabbar [data-fd-mobile-nav]').press('Enter');
    await page.locator('#im-mobile-nav').waitFor();
    await page.locator('#im-mobile-nav').getByRole('link', { name: 'Settings', exact: true }).press('Enter');
    await page.getByRole('heading', { name: 'Full configuration' }).waitFor();
});
