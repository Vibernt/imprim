import test from 'node:test';
import assert from 'node:assert/strict';

export function loadingSmoke(open) {
    test('startup and route skeletons keep the shell and give way to the first render', async t => {
        const { page, server } = await open(t, { width: 375, role: 'platform' });
        const startup = Promise.withResolvers();
        const clients = Promise.withResolvers();
        await page.route('**/v1/me', async route => { await startup.promise; await route.continue(); });
        await page.route(url => url.pathname === '/admin/api/clients', async route => { await clients.promise; await route.continue(); });
        try {
            const response = await page.goto(server.origin + '/admin/clients', { waitUntil: 'domcontentloaded' });
            const first = page.locator('body > .fd-skeleton-app:has(+ app-shell)');
            assert.match(response.headers()['content-security-policy'], /style-src 'self'/);
            assert.match(await response.text(), /class="fd-skeleton-app"/);
            await first.locator('.fd-skeleton-app-tabbar').waitFor();
            assert.equal(await first.locator('.fd-skeleton-app-side').count(), 1);
            assert.ok(await first.locator('.fd-skeleton-table-row').count() > 0);
            assert.equal(await page.locator('main').count(), 0);
            startup.resolve();
            await first.waitFor({ state: 'detached' });

            const body = page.locator('main#main [data-fd-loading="true"]');
            await page.getByRole('heading', { name: 'Clients', exact: true }).waitFor();
            await page.locator('.fd-tabbar').waitFor();
            await body.locator('.fd-skeleton-table-row').first().waitFor();
            const late = body.locator('.fd-skeleton-late');
            assert.equal(await late.getAttribute('data-fd-late'), 'wait');
            await page.locator('.fd-skeleton-late[data-fd-late="shown"]').waitFor({ timeout: 12000 });
            assert.equal(await late.getByRole('status').textContent(), 'Still loading. This is taking longer than usual.');
            clients.resolve();
            await page.getByRole('table', { name: 'Clients', exact: true }).waitFor();
            await body.waitFor({ state: 'detached' });
        } finally {
            startup.resolve();
            clients.resolve();
        }
    });

    test('a startup error removes the static skeleton', async t => {
        const { page } = await open(t);
        await page.route('**/v1/me', route => route.fulfill({ contentType: 'application/json', body: 'null' }));
        await page.reload();
        await page.locator('main#main').getByRole('heading', { name: 'The page did not load' }).waitFor();
        assert.equal(await page.locator('.fd-skeleton-app').count(), 0);
    });

    test('Tab reaches the skip link and Enter focuses main without a route change', async t => {
        const { page } = await open(t);
        const reads = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/v1/account/profile') reads.push(request.url());
        });
        await page.keyboard.press('Tab');
        const skip = page.getByRole('link', { name: 'Skip to content' });
        assert.equal(await skip.evaluate(link => document.activeElement === link), true);
        await page.keyboard.press('Enter');
        const main = page.locator('main#main');
        await page.waitForFunction(() => document.activeElement?.matches('main#main'));
        assert.equal(await main.evaluate(el => getComputedStyle(el).boxShadow), 'none');
        assert.equal(new URL(page.url()).pathname, '/account');
        assert.equal(await page.locator('#im-route-status').textContent(), '');
        assert.deepEqual(reads, []);
    });
}
