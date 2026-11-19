import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { accountSmoke } from './smoke-account.mjs';
import { smokeServer } from './smoke-server.mjs';
import { adminCoreSmoke } from './smoke-admin-core.mjs';

const browser = await chromium.launch();
test.after(() => browser.close());

async function open(t, { width = 1440, colorScheme = 'light', role = null, expectedBadRequest } = {}) {
    const server = await smokeServer(t, role);
    const context = server.track(await browser.newContext({ viewport: { width, height: 900 }, colorScheme, locale: 'en-US' }));
    t.after(() => context.close());
    await context.addCookies(server.cookies);
    const page = await context.newPage(), failures = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const expected = expectedBadRequest && message.location().url === server.origin + expectedBadRequest
            && /Failed to load resource:.*status of 400/.test(message.text());
        if (!expected) failures.push(message.text());
    });
    page.on('requestfailed', request => {
        const error = request.failure()?.errorText;
        if (error !== 'net::ERR_ABORTED') failures.push(`${request.url()}: ${error}`);
    });
    t.after(() => assert.deepEqual(failures, []));
    await page.goto(`${server.origin}/account`);
    await page.locator('screen-profile #display_name').waitFor();
    assert.equal(await page.title(), 'Profile · Vibernt');
    assert.equal(await page.locator('html').getAttribute('data-palette'), 'glacier');
    assert.equal(await page.locator('html').getAttribute('data-type'), 'book');
    assert.equal(await page.locator('html').getAttribute('data-density'), 'compact');
    assert.ok(await page.locator('head link[href^="/assets/theme.css?v="]').count());
    assert.equal(await page.locator('.fd-topbar-title').textContent(), 'Vibernt');
    const background = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
    const channels = background.match(/\d+/g)?.map(Number);
    assert.equal(channels?.slice(0, 3).every(value => value < 128), colorScheme === 'dark', background);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'profile fits the viewport');
    return { page, server };
}

test('Profile writes through the Worker, uses its catalogue, and confirms email in the browser', async t => {
    const { page, server } = await open(t);
    assert.equal(await page.locator('.fd-sidebar a[href^="/admin"]').count(), 0);
    assert.equal(await page.locator('button[data-fd-confirm-submit]').isDisabled(), true);
    const name = page.locator('#display_name');
    await name.fill('  Ada Lovelace  ');
    await name.press('Tab');
    await page.keyboard.press('Enter');
    await page.getByText('Name saved', { exact: true }).waitFor();
    assert.equal(await name.inputValue(), 'Ada Lovelace');
    assert.equal(server.env.DB.db.prepare('SELECT display_name FROM users').get().display_name, 'Ada Lovelace');

    await page.locator('#locale').selectOption('fr');
    await page.getByRole('button', { name: 'Save language' }).click();
    await page.getByRole('heading', { name: 'Profil', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
    assert.equal(await page.locator('#locale').inputValue(), 'fr');
    assert.equal(await page.locator('#display_name').inputValue(), 'Ada Lovelace');
    await page.locator('#locale').selectOption('');
    await page.locator('form').filter({ has: page.locator('#locale') }).locator('button').click();
    await page.getByRole('button', { name: 'Change email' }).waitFor();

    await page.locator('#new_email').fill('updated@example.com');
    await page.getByRole('button', { name: 'Change email' }).click();
    await page.getByText('Confirmation link sent', { exact: true }).waitFor();
    await server.drain();
    const mail = server.mails.find(message => message.to === 'updated@example.com');
    assert.ok(mail);
    const confirmation = mail.text.match(/\/account\/email\/confirm\?token=[\w-]+/)[0];
    await page.goto(server.origin + confirmation);
    await page.getByRole('button', { name: 'Change email' }).click();
    await page.getByText('Email changed', { exact: true }).waitFor();
    await page.locator('screen-profile .fd-mono').filter({ hasText: 'updated@example.com' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/account');

    await page.locator('#confirm_email').fill('UPDATED@EXAMPLE.COM');
    await page.getByRole('button', { name: 'Delete account' }).click();
    await page.waitForURL('**/signed-out');
    assert.equal(server.env.DB.db.prepare('SELECT status FROM users').get().status, 'deleted');
    assert.ok(!(await page.context().cookies()).some(cookie => cookie.name === '__Host-vi_session'));
    await server.drain();
});

accountSmoke(open);

for (const role of ['realm', 'platform']) test(`${role} navigation is gated by the roster role`, async t => {
    const { page, server } = await open(t, { role });
    await page.goto(server.origin + '/account/security');
    await page.locator('screen-security').getByRole('heading', { name: 'Security', exact: true }).waitFor();
    const sidebar = page.locator('.fd-nav');
    assert.equal(await sidebar.getByRole('link', { name: 'Signing keys' }).count(), role === 'platform' ? 1 : 0);
    await sidebar.getByRole('link', { name: 'Clients', exact: true }).click();
    await page.locator('screen-admin-clients').getByRole('heading', { name: 'Clients', exact: true }).waitFor();
    assert.equal(await sidebar.getByRole('link', { name: 'Clients', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.fd-account-email').textContent(), 'admin@example.com');
    if (role === 'platform') {
        await sidebar.getByRole('link', { name: 'Signing keys' }).click();
        await page.locator('screen-signing-keys').getByRole('heading', { name: 'Signing keys' }).waitFor();
        // The screen loads its keys after the heading shows; let that request finish before the server stops.
        await page.locator('screen-signing-keys').getByRole('table', { name: 'Signing keys' }).waitFor();
    } else {
        await page.evaluate(() => {
            const link = document.createElement('a');
            link.href = '/admin/keys';
            document.body.append(link);
            link.click();
        });
        await page.locator('screen-no-access').getByRole('heading', { name: 'No access' }).waitFor();
    }
});

adminCoreSmoke(open);
