import test from 'node:test';
import { useWebShell } from './support/web-shell.mjs';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { world, begin, turnstile } from './support/world.mjs';
import { adminLogin, assertFireMarkup } from './support/admin.mjs';
import { signInPage } from '../apps/server/src/pages/sign-in.mjs';
for (const path of ['/login', '/check-email', '/error', '/signed-out']) test(`self-contained page smoke: ${path}`, async t => {
    const w = await world(t), response = await w.call(path), html = await response.text();
    assert.equal(response.status, path === '/error' ? 400 : 200);
    // Turnstile's origin appears only on the page that renders the widget.
    const turnstile = path === '/login' ? " https://challenges.cloudflare.com" : '', frames = path === '/login' ? 'https://challenges.cloudflare.com' : "'none'";
    assert.equal(response.headers.get('content-security-policy'), `default-src 'self'; script-src 'self'${turnstile}; frame-src ${frames}; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    assert.match(html, /<html lang="en" data-fd-surface="app">/);
    if (path !== '/login') assert.ok(!/<(?:script|link|img|iframe)[^>]+(?:src|href)="https?:/i.test(html));
    assert.equal(response.headers.get('referrer-policy'), 'same-origin', 'no-referrer makes browsers send Origin: null on form POSTs, which the origin check refuses');
});
test('every page shows the realm name, escaped, and no product is written into the code', async t => {
    const w = await world(t), html = await (await w.call('/signed-out')).text();
    // The brand leads, centred: its initial in dots (no mark is uploaded) and its name. Imprim signs the page below.
    assert.match(html, /<div class="fd-screen fd-rise"><div class="fd-brand"><span class="fd-brand-mark"><svg viewBox="-1 0 7 7"[^>]*>[\s\S]*?<\/svg><\/span><span class="fd-brand-name">Vibernt<\/span><\/div>/);
    assert.match(html, /<p class="fd-screen-note"><span>Powered by<\/span><svg class="fd-wordmark" data-size="sm"[^>]*aria-label="Imprim">/);
    assert.match(html, /<title>Signed out · Vibernt<\/title>/);
    // Every class is Fire's own: there are no stopgap rules, so no page links the stopgap stylesheet.
    assertFireMarkup(html);
    assert.ok(!html.includes('local.css') && !/class="[^"]*\bim-/.test(html));
    assert.ok(!(await (await w.call('/assets/local.css')).text()).includes('{'));
    w.env.DB.db.prepare("UPDATE realms SET display_name=? WHERE id='default'").run('<b>Acme</b>');
    const { forgetRealms } = await import('../apps/server/src/realms/realm.mjs'); forgetRealms(w.env);
    const escaped = await (await w.call('/signed-out')).text();
    assert.ok(escaped.includes('&lt;b&gt;Acme&lt;/b&gt;') && !escaped.includes('<b>Acme'));
    assert.ok(!escaped.includes('identity:brand'));
    assert.equal((await w.call('/assets/logo.svg')).status, 404);
});
test('sign-in page escapes client branding and holds pending request id', async t => {
    const w = await world(t);
    w.env.DB.db.prepare('UPDATE clients SET branding=?').run(JSON.stringify({ name: '<script>alert(1)</script>' }));
    const flow = await begin(w); assert.ok(flow.request_id);
    const response = signInPage(w.env, 'id', [], { sign_in_methods: '["email"]', google_hosted_domains: '[]', branding: '{"name":"<img onerror=alert(1)>"}' });
    const html = await response.text(); assert.ok(!html.includes('<img onerror')); assert.match(html, /&lt;img/);
});
test('fragment page never sends token on load; explicit click posts once and navigates via JSON', async t => {
    const w = await world(t), html = await (await w.call('/login')).text();
    assert.match(html, /<script src="\/assets\/sign-in.js" defer><\/script>/);
    const script = await (await w.call('/assets/sign-in.js')).text();
    const elements = new Map(), requests = [], navigations = [], history = [];
    const document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { hidden: id === 'confirm', handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
        return elements.get(id);
    } };
    runInNewContext(script, {
        document, URLSearchParams, window: {},
        location: { hash: '#token=' + 'a'.repeat(43), pathname: '/login', search: '?request_id=example', assign(url) { navigations.push(url); } },
        history: { replaceState(...args) { history.push(args); } },
        async fetch(url, options) { requests.push({ url, options }); return Response.json({ redirect: 'https://app.example/callback?code=issued' }); }
    });
    assert.equal(requests.length, 0);
    assert.equal(document.getElementById('confirm').hidden, false);
    assert.equal(document.getElementById('request').hidden, true);
    assert.equal(history[0][2], '/login?request_id=example');
    await document.getElementById('verify').handlers.click();
    assert.equal(requests.length, 1); assert.equal(requests[0].url, '/v1/auth/magic/verify');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(JSON.parse(requests[0].options.body).browser_response, true);
    assert.deepEqual(navigations, ['https://app.example/callback?code=issued']);
});
test('legacy admin form responses retain the Fire shell, same-origin scripts and role-based navigation', async t => {
    const w = await world(t); turnstile(t);
    const a = await adminLogin(w);
    const legacyResponse = async () => {
        const response = await w.call('/admin/clients', { method: 'POST',
            headers: { cookie: a.cookie, accept: 'text/html', origin: w.env.ISSUER, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf: a.csrf, redirect_uris: 'invalid' }) });
        assert.equal(response.status, 400);
        return { response, html: await response.text() };
    };
    const { response, html } = await legacyResponse();
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    assert.match(html, /<div class="fd-app" data-sidebar="expanded"><aside class="fd-sidebar" aria-label="Admin console">/);
    assert.match(html, /<a class="fd-nav-item" href="\/admin\/clients" aria-current="page">/);
    assert.match(html, /<span class="fd-account-email">admin@example\.com<\/span>/);
    assert.deepEqual([...html.matchAll(/<script[^>]*>/g)].map(m => m[0]), [
        '<script type="application/json" data-fd-labels>', '<script src="/imprim/head.js">', '<script type="module" src="/imprim/shell.js">'
    ], 'label data, then the head script after every stylesheet, then the shell module');
    assertFireMarkup(html);
    // A platform administrator sees the platform pages; a realm administrator is not shown them.
    assert.ok(html.includes('href="/admin/keys"') && html.includes('href="/admin/realms"') && !html.includes('identity:'));
    w.env.DB.db.exec("UPDATE admins SET role='realm'");
    const realm = (await legacyResponse()).html;
    assert.ok(!realm.includes('href="/admin/keys"') && !realm.includes('href="/admin/realms"') && !realm.includes('Platform') && !realm.includes('identity:'));
    assert.equal((await a.get('keys')).status, 403);
    const accountMfa = await w.call('/account/mfa', { headers: { cookie: a.cookie } });
    assert.match(await accountMfa.text(), /<a class="fd-nav-item" href="\/admin">/);

    await useWebShell(t, w.env);
    const read = path => w.call(path, { headers: { cookie: a.cookie, accept: 'text/html' } });
    assert.equal((await read('/admin/keys')).status, 403);
    assert.equal((await read('/admin/realms')).status, 403);
    const branding = await read('/admin/branding');
    assert.equal(branding.status, 200);
    assert.match(branding.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self';/);
    assert.match(await branding.text(), /<app-shell><\/app-shell>/);
});
test('the forms script loads Fire\'s forms module and makes no request of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const script = readFileSync(new URL('../apps/server/public/imprim/forms.js', import.meta.url), 'utf8');
    assert.deepEqual([...script.matchAll(/import\('([^']+)'\)/g)].map(m => m[1]), ['/fire/js/forms.js']);
    assert.ok(!/fetch\(|XMLHttpRequest|https?:/.test(script));
});
test('the shell script loads two Fire modules and makes no request of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const script = readFileSync(new URL('../apps/server/public/imprim/shell.js', import.meta.url), 'utf8');
    assert.deepEqual([...script.matchAll(/import\('([^']+)'\)/g)].map(m => m[1]), ['/fire/js/shell.js', '/fire/js/texture.js']);
    assert.ok(!/fetch\(|XMLHttpRequest|https?:/.test(script));
});

test('a classic script ends every server page head, after every stylesheet (Fire 0.12.3)', async t => {
    const w = await world(t);
    for (const path of ['/login', '/account']) {
        const html = await (await w.call(path, { headers: { accept: 'text/html' } })).text();
        const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>') + 7);
        assert.match(head, /<script src="\/imprim\/head\.js"><\/script><\/head>$/, `${path}: head.js closes <head>`);
        const lastSheet = head.lastIndexOf('rel="stylesheet"'), script = head.indexOf('<script src="/imprim/head.js">');
        assert.ok(lastSheet >= 0 && lastSheet < script, `${path}: every stylesheet comes before head.js`);
        assert.doesNotMatch(head, /<script[^>]*(?:async|defer)[^>]*src="\/imprim\/head\.js"/);
    }
});
