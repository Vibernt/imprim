import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { login, world } from './support/world.mjs';
import { TestHTMLRewriter } from './support/html-rewriter.mjs';
import { adminLogin } from './support/admin.mjs';
import { fireLabels } from './support/i18n.mjs';
import { WEB_PATHS } from '../apps/server/src/web/serve.mjs';

const index = await readFile(new URL('./fixtures/web/index.html', import.meta.url), 'utf8');
const accept = { accept: 'text/html' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

test('a signed-out account visit gets the account sign-in message, never /login, before assets are read', async t => {
    const w = await world(t);
    w.env.ASSETS = { fetch() { assert.fail('unsigned request read assets'); } };
    const response = await w.call('/account?changed=email', { headers: accept });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('location'), null);
    assert.match(await response.text(), /Sign in to see your account/);
});

test('the signed-in shell uses the person’s language, realm look, and strict headers', async t => {
    globalThis.HTMLRewriter = TestHTMLRewriter;
    t.after(() => { delete globalThis.HTMLRewriter; });
    const w = await world(t);
    const logo = 'a'.repeat(64), dark = 'b'.repeat(64), name = 'Brand </script><p>&';
    w.env.DB.db.prepare("UPDATE realms SET config=json_set(config,'$.branding',json(?)) WHERE id='default'").run(JSON.stringify({
        name, locale: 'fr-CA', logo_light: logo, logo_dark: dark, look: { palette: 'glacier', type: 'book', density: 'compact', corners: 0.5 }
    }));
    const { cookie } = await login(w, t);
    w.env.DB.db.prepare("UPDATE users SET locale='fr'").run();
    const requests = [];
    w.env.ASSETS = { fetch(request) {
        requests.push(request);
        return new Response(index, { headers: { 'content-type': 'text/html', etag: '"raw-shell"', 'cache-control': 'public' } });
    } };
    const response = await w.call('/account', { headers: { ...accept, cookie, 'accept-language': 'de' } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<html data-fd-surface="app" lang="fr-CA" data-palette="glacier" data-type="book" data-density="compact">/);
    assert.match(html, /href="\/assets\/theme\.css\?v=[a-f0-9]{64}"/);
    assert.equal(fireLabels(html)['menu.close'], 'Fermer le menu');
    const brand = html.match(/<script type="application\/json" data-fd-brand>([\s\S]+?)<\/script>/)[1];
    assert.ok(!brand.includes('<'));
    assert.deepEqual(JSON.parse(brand), { name, logo: `/assets/brand/${logo}`, logoDark: `/assets/brand/${dark}` });
    assert.equal(response.headers.get('content-security-policy'), csp);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(response.headers.get('etag'), null);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, '/ui/index.html');
    assert.equal(requests[0].headers.get('cookie'), null);

    for (const headers of [{ accept: 'application/json' }, { accept: 'text/html;q=0, application/json' }, {}]) {
        assert.equal((await w.call('/account', { headers: { ...headers, cookie } })).status, 404);
    }
    for (const path of ['/account/security', '/account/sessions', '/account/agents']) {
        const shell = await w.call(path, { headers: { ...accept, cookie } });
        assert.equal(shell.status, 200);
        assert.match(await shell.text(), /<app-shell><\/app-shell>/);
        assert.equal(shell.headers.get('content-security-policy'), csp);
        assert.equal((await w.call(path, { headers: { cookie, accept: 'application/json' } })).status, 404);
        assert.equal((await w.call(path, { headers: accept })).status, 401);
    }
    const admin = await w.call('/admin/clients', { headers: accept });
    assert.equal(admin.headers.get('location'), '/login?next=%2Fadmin%2Fclients');
    assert.equal((await w.call('/ui/index.html', { headers: { ...accept, cookie } })).status, 404);
    assert.equal(requests.length, 4);
});

test('a missing or misrouted asset fails as unavailable', async t => {
    const w = await world(t), { cookie } = await login(w, t);
    const get = () => w.call('/account', { headers: { ...accept, cookie } });
    assert.equal((await get()).status, 503);
    for (const response of [Response.redirect(w.env.ISSUER + '/ui/'), new Response('missing', { status: 404 })]) {
        w.env.ASSETS = { fetch: async () => response };
        const result = await get();
        assert.equal(result.status, 503);
        assert.match(await result.text(), /The account interface is unavailable/);
    }
});

test('a parameterized admin path is subject to the existing scoped MFA and platform checks before serving the shell', async t => {
    const pattern = '/admin/keys/:id';
    WEB_PATHS.add(pattern);
    globalThis.HTMLRewriter = TestHTMLRewriter;
    t.after(() => {
        WEB_PATHS.delete(pattern);
        delete globalThis.HTMLRewriter;
    });
    const w = await world(t), person = await login(w, t), admin = await adminLogin(w);
    const db = w.env.DB.db, path = '/admin/keys/current';
    const get = (cookie, target = path) => w.call(target, { headers: { ...accept, cookie } });
    let reads = 0;
    w.env.ASSETS = { fetch() { reads++; return new Response(index, { headers: { 'content-type': 'text/html' } }); } };
    assert.equal((await get('')).headers.get('location'), '/login?next=%2Fadmin%2Fkeys%2Fcurrent');
    assert.equal((await get(person.cookie)).status, 403);
    db.prepare("UPDATE admins SET role='realm'").run();
    assert.equal((await get(admin.cookie)).status, 403);
    db.prepare("UPDATE admins SET role='platform'").run();
    db.prepare('UPDATE sessions SET mfa_at=0 WHERE admin_until IS NOT NULL').run();
    assert.equal((await get(admin.cookie)).headers.get('location'), '/mfa?next=%2Fadmin%2Fkeys%2Fcurrent');
    db.prepare('UPDATE sessions SET mfa_at=? WHERE admin_until IS NOT NULL').run(Date.now());
    assert.equal((await get(admin.cookie, path + '/extra')).status, 404);
    assert.equal(reads, 0);
    const shell = await get(admin.cookie);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<app-shell><\/app-shell>/);
    assert.equal(reads, 1);
});

test('the Lit shell registers all account and admin routes', () => {
    assert.deepEqual(WEB_PATHS, new Set([
        '/account', '/account/security', '/account/sessions', '/account/agents',
        '/admin', '/admin/clients', '/admin/clients/new', '/admin/clients/:id', '/admin/services',
        '/admin/users', '/admin/users/:id', '/admin/users/:id/merge', '/admin/audit',
        '/admin/workspaces', '/admin/workspaces/:id', '/admin/workspaces/:id/close',
        '/admin/branding', '/admin/settings', '/admin/keys', '/admin/realms'
    ]));
});

test('ported admin URLs serve the English Lit shell and keep the preview paths outside it', async t => {
    globalThis.HTMLRewriter = TestHTMLRewriter;
    t.after(() => { delete globalThis.HTMLRewriter; });
    const w = await world(t);
    const person = await login(w, t), admin = await adminLogin(w);
    const brand = await (await admin.get('branding')).json();
    assert.equal((await admin.post('branding', { version: brand.version, branding: { name: '</script><script>bad</script>' } })).status, 200);
    let shellReads = 0;
    w.env.ASSETS = { fetch() {
        shellReads++;
        return new Response(index, { headers: { 'content-type': 'text/html' } });
    } };
    const paths = ['/admin', '/admin/clients', '/admin/clients/new', '/admin/clients/app', '/admin/services',
        '/admin/users', '/admin/users/user_test', '/admin/users/user_test/merge', '/admin/audit',
        '/admin/workspaces', '/admin/workspaces?create=1', '/admin/workspaces/ws_test', '/admin/workspaces/ws_test/close',
        '/admin/branding', '/admin/settings', '/admin/keys', '/admin/realms'];
    for (const path of paths) {
        assert.equal((await w.call(path, { headers: accept })).headers.get('location'), '/login?next=' + encodeURIComponent(path), path);
        assert.equal((await w.call(path, { headers: { ...accept, cookie: person.cookie } })).status, 403, path);
        const response = await w.call(path, { headers: { ...accept, cookie: admin.cookie, 'accept-language': 'fr' } });
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('content-security-policy'), csp);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const html = await response.text();
        assert.match(html, /<html data-fd-surface="app" lang="en">/);
        assert.match(html, /<app-shell><\/app-shell>/);
        assert.doesNotMatch(html, /<script>bad<\/script>/);
        assert.equal(fireLabels(html)['menu.close'], 'Close menu');
        assert.equal((await w.call(path, { headers: { accept: 'application/json', cookie: admin.cookie } })).status, 404, path);
    }
    for (const path of ['/admin/keys', '/admin/realms']) {
        w.env.DB.db.exec("UPDATE admins SET role='realm'");
        assert.equal((await w.call(path, { headers: { ...accept, cookie: admin.cookie } })).status, 403, path);
    }
    for (const path of ['/admin/branding/preview?client=app', '/admin/api/branding/preview?client=app', '/admin/branding/email-preview']) {
        const response = await w.call(path, { headers: { ...accept, cookie: admin.cookie } });
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('x-robots-tag'), 'noindex', path);
        assert.doesNotMatch(await response.text(), /<app-shell>/, path);
    }
    for (const path of ['/admin/branding/preview/extra', '/admin/api/branding/preview/extra', '/admin/api/branding/email-preview']) {
        assert.equal((await w.call(path, { headers: { ...accept, cookie: admin.cookie } })).status, 404, path);
    }
    assert.equal(shellReads, paths.length);
});
