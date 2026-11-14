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
    assert.equal(response.status, 200); assert.match(await response.text(), /method="post"/);
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
