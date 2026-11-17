import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login } from './support/world.mjs';
const query = () => new URLSearchParams({ client_id: 'app', post_logout_redirect_uri: 'https://app.example/bye', state: 'logout-state' });
async function submit(w, signed, changes = {}, headers = {}) {
    const csrf = signed.cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    return w.call('/logout', { method: 'POST', headers: { origin: w.env.ISSUER, cookie: signed.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ ...Object.fromEntries(query()), csrf, ...changes }) });
}
test('logout confirms first, requires CSRF POST, revokes identity/access session and preserves state', async t => {
    const w = await world(t), signed = await login(w, t);
    const tokens = await (await w.exchange(signed.code)).json();
    const response = await w.call('/logout?' + query(), { headers: { cookie: signed.cookie } });
    const html = await response.text();
    assert.equal(response.status, 200); assert.match(html, /<form method="post" action="\/logout">/);
    assert.match(html, /<h1 class="fd-h1">Sign out of [^<]+\?<\/h1>/);
    for (const [name, value] of [['client_id', 'app'], ['post_logout_redirect_uri', 'https://app.example/bye'], ['state', 'logout-state']])
        assert.ok(html.includes(`<input type="hidden" name="${name}" value="${value}">`), name);
    assert.match(html, /<input type="hidden" name="csrf" value="[^"]+">/);
    // Chrome applies form-action to the redirect after the POST, so the page allows the registered post-logout origin.
    assert.match(response.headers.get('content-security-policy'), /form-action 'self' https:\/\/app\.example;/);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    const out = await submit(w, signed); assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), 'https://app.example/bye?state=logout-state');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM access_tokens').get().n, 0);
    for (const cookie of out.headers.getSetCookie()) assert.match(cookie, /Max-Age=0/);
    assert.equal((await w.call('/userinfo', { headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 401);
});
for (const kind of ['unregistered uri', 'http uri', 'javascript uri', 'wrong client', 'wrong csrf', 'missing origin', 'wrong origin', 'missing cookie', 'double submit mismatch'])
    test(`logout refuses ${kind} without revoking session`, async t => {
        const w = await world(t), signed = await login(w, t);
        const changes = kind === 'unregistered uri' ? { post_logout_redirect_uri: 'https://evil.example' }
            : kind === 'http uri' ? { post_logout_redirect_uri: 'http://app.example/bye' }
            : kind === 'javascript uri' ? { post_logout_redirect_uri: 'javascript:alert(1)' }
            : kind === 'wrong client' ? { client_id: 'missing' } : kind === 'wrong csrf' ? { csrf: 'bad' } : {};
        const headers = kind === 'missing origin' ? { origin: '' } : kind === 'wrong origin' ? { origin: 'https://evil.example' }
            : kind === 'missing cookie' ? { cookie: '' } : kind === 'double submit mismatch' ? { cookie: signed.cookie.replace(/__Host-vi_csrf=[^;]+/, '__Host-vi_csrf=wrong') } : {};
        const response = await submit(w, signed, changes, headers);
        assert.ok([400,403].includes(response.status));
        assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    });
test('logout GET refuses unregistered post_logout URI, without session', async t => {
    const w = await world(t), params = query(); params.set('post_logout_redirect_uri', 'https://evil.example/');
    const response = await w.call('/logout?' + params); assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
});
test('logout without an identity session returns to registered client; no URI uses signed-out page', async t => {
    const w = await world(t);
    assert.equal((await w.call('/logout?' + query())).headers.get('location'), 'https://app.example/bye?state=logout-state');
    assert.equal((await w.call('/logout?client_id=app')).headers.get('location'), w.env.ISSUER + '/signed-out');
});

test('RP logout verifies ID-token hint, derives client, and still asks for confirmation', async t => {
    const w = await world(t), signed = await login(w, t), tokens = await (await w.exchange(signed.code)).json();
    const params = new URLSearchParams({ id_token_hint: tokens.id_token, post_logout_redirect_uri: 'https://app.example/bye' });
    const response = await w.call('/logout?' + params, { headers: { cookie: signed.cookie } });
    assert.equal(response.status, 200); assert.match(await response.text(), /value="app"/);
});
for (const kind of ['alg none', 'alg HS256', 'swapped payload', 'wrong client', 'wrong browser session', 'unknown kid']) test(`RP logout refuses hint ${kind}`, async t => {
    const w = await world(t), signed = await login(w, t), tokens = await (await w.exchange(signed.code)).json();
    let hint = tokens.id_token, cookie = signed.cookie;
    if (kind.startsWith('alg') || kind === 'unknown kid') {
        const parts = hint.split('.'), header = JSON.parse(Buffer.from(parts[0], 'base64url'));
        if (kind === 'unknown kid') header.kid = 'unknown'; else header.alg = kind === 'alg none' ? 'none' : 'HS256';
        parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url'); hint = parts.join('.');
    }
    if (kind === 'swapped payload') { const parts = hint.split('.'); parts[1] = Buffer.from('{"sub":"attacker"}').toString('base64url'); hint = parts.join('.'); }
    if (kind === 'wrong browser session') cookie = (await login(w, t, 'other@example.com')).cookie;
    const params = new URLSearchParams({ client_id: kind === 'wrong client' ? 'other' : 'app', id_token_hint: hint });
    assert.equal((await w.call('/logout?' + params, { headers: { cookie } })).status, 400);
});

test('malformed base64url hint signature is a client error', async t => {
    const w = await world(t), signed = await login(w, t), tokens = await (await w.exchange(signed.code)).json();
    const hint = tokens.id_token.split('.').slice(0,2).join('.') + '.A';
    assert.equal((await w.call('/logout?' + new URLSearchParams({ id_token_hint: hint }), { headers: { cookie: signed.cookie } })).status, 400);
});
test('logout confirmation escapes the state it carries back', async t => {
    const w = await world(t), signed = await login(w, t);
    const params = new URLSearchParams({ client_id: 'app', post_logout_redirect_uri: 'https://app.example/bye', state: '"><img src=x onerror=alert(1)>' });
    const html = await (await w.call('/logout?' + params, { headers: { cookie: signed.cookie } })).text();
    assert.ok(html.includes('<input type="hidden" name="state" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">'));
    assert.doesNotMatch(html.split('<main class="fd-page">')[1], /<img|<script/);
});
test('a person signs out from Imprim\'s own pages: no app is named, so nothing outside can be reached', async t => {
    const w = await world(t), signed = await login(w, t);
    const csrf = signed.cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const sessions = () => w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n;
    // The account pages link to it.
    assert.match(await (await w.call('/account', { headers: { cookie: signed.cookie } })).text(), /<a class="fd-btn" data-variant="ghost" data-only="desktop" href="\/logout">/);
    // GET only asks; it changes nothing.
    const ask = await w.call('/logout', { headers: { cookie: signed.cookie } });
    assert.equal(ask.status, 200);
    const html = await ask.text();
    assert.match(html, /<form method="post" action="\/logout">/); assert.match(html, /href="\/account"[^>]*><span>Stay signed in<\/span>/);
    assert.equal(ask.headers.get('content-security-policy').match(/form-action ([^;]+)/)[1], "'self'");
    assert.equal(sessions(), 1);
    // Without an app, a return address is refused, on GET and on POST. (A lone state is dropped instead; see
    // oidc-certification.test.mjs.)
    for (const extra of [{ post_logout_redirect_uri: 'https://evil.example/' }, { post_logout_redirect_uri: 'https://app.example/bye' }]) {
        assert.equal((await w.call('/logout?' + new URLSearchParams(extra), { headers: { cookie: signed.cookie } })).status, 400);
        const post = await w.call('/logout', { method: 'POST', headers: { origin: w.env.ISSUER, cookie: signed.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...extra }) });
        assert.equal(post.status, 400);
    }
    // The POST needs the CSRF value and this origin.
    const post = (body, headers = {}) => w.call('/logout', { method: 'POST', headers: { origin: w.env.ISSUER, cookie: signed.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
    assert.equal((await post({ client_id: '', csrf: 'wrong' })).status, 403);
    assert.equal((await post({ client_id: '', csrf }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(sessions(), 1);
    const out = await post({ client_id: '', post_logout_redirect_uri: '', state: '', id_token_hint: '', csrf });
    assert.equal(out.status, 303); assert.equal(out.headers.get('location'), w.env.ISSUER + '/signed-out');
    assert.equal(sessions(), 0);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='sign_out'").get().n, 1);
    // Signed out already: straight to the signed-out page.
    assert.equal((await w.call('/logout')).headers.get('location'), w.env.ISSUER + '/signed-out');
});
