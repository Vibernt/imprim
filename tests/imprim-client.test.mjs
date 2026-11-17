import { forgetJwks } from '../apps/server/src/oidc/keys.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, IdentityError } from '../packages/imprim-client/index.mjs';
import { world, cookieJar } from './support/world.mjs';
import { fakeGoogle, googleCallback } from './support/google.mjs';
import { signingKey } from '../apps/server/src/oidc/keys.mjs';
import { seal } from '../apps/server/src/lib/crypto.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function setup(t) {
    const w = await world(t);
    let discoveryCalls = 0, jwksCalls = 0;
    const fetch = async (input, init = {}) => {
        const url = new URL(input);
        assert.equal(url.origin, w.env.ISSUER);
        if (url.pathname === '/.well-known/openid-configuration') discoveryCalls++;
        if (url.pathname === '/.well-known/jwks.json') jwksCalls++;
        return w.call(url.pathname + url.search, init);
    };
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', clientSecret: 'secret', redirectUri: 'https://app.example/callback', fetch });
    async function start(cookie = '', options = {}) {
        const login = await client.startLogin(options);
        const response = await w.call(new URL(login.url).pathname + new URL(login.url).search, { headers: { cookie } });
        return { login, response, cookie: [cookie, cookieJar(response)].filter(Boolean).join('; '), request_id: (await response.text()).match(/data-request-id="([^"]+)"/)?.[1] };
    }
    async function magic(flow) {
        const original = globalThis.fetch;
        globalThis.fetch = async url => {
            assert.match(String(url), /challenges.cloudflare.com/);
            return Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' });
        };
        try {
            await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, flow.cookie);
            await w.drain();
            const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
            return w.post('/v1/auth/magic/verify', { token }, flow.cookie);
        } finally { globalThis.fetch = original; }
    }
    return { w, client, start, magic, get discoveryCalls() { return discoveryCalls; }, get jwksCalls() { return jwksCalls; } };
}
const callback = response => response.headers.get('location');
async function signed(w, claims = {}, header = {}) {
    const { kid, key } = await signingKey(w.env);
    const now = Math.floor(Date.now() / 1000);
    const data = { iss: w.env.ISSUER, aud: 'app', azp: 'app', sub: 'person', nonce: 'n', iat: now, exp: now + 600, auth_time: now, ...claims };
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'ES256', kid, ...header })}.${encode(data)}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(sig).toString('base64url')}`;
}
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof IdentityError && error.code === code);

test('client magic link, discovery cache, replay, state and issuer boundaries', async t => {
    const x = await setup(t), flow = await x.start();
    assert.equal(flow.response.status, 200);
    const response = await x.magic(flow), url = callback(response);
    const claims = await x.client.handleCallback(url, flow.login);
    assert.equal(claims.amr[0], 'email'); assert.equal(claims.nonce, flow.login.nonce);
    assert.equal(x.discoveryCalls, 1);
    await rejects(x.client.handleCallback(url, flow.login), 'invalid_grant');
    await rejects(x.client.handleCallback(url, { ...flow.login, state: 'other' }), 'invalid_state');
    await rejects(x.client.handleCallback(new URL(url).origin + new URL(url).pathname + '?code=abc', flow.login), 'invalid_state');
    const changed = new URL(url); changed.searchParams.set('iss', 'https://evil.example');
    await rejects(x.client.handleCallback(changed, flow.login), 'invalid_issuer');
    const errorUrl = new URL(url); errorUrl.searchParams.delete('code'); errorUrl.searchParams.set('error', 'login_required');
    await rejects(x.client.handleCallback(errorUrl, flow.login), 'login_required');
});

test('client callback returns the exact ID token only when requested and verified', async t => {
    const { w } = await setup(t);
    const idToken = await signed(w);
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    const redirectUri = 'https://app.example/callback';
    const url = new URL(redirectUri);
    url.search = new URLSearchParams({ code: 'code', state: 'state', iss: w.env.ISSUER });
    const login = { state: 'state', nonce: 'n', codeVerifier: 'verifier' };
    let exchanges = 0;
    const client = createClient({
        issuer: w.env.ISSUER, clientId: 'app', redirectUri,
        async fetch(input, init) {
            const { pathname } = new URL(input);
            if (pathname !== '/token') return w.call(pathname, init);
            exchanges++;
            return Response.json({ id_token: idToken });
        },
    });

    for (const idToken of ['yes', 1, null]) {
        await rejects(client.handleCallback(url, login, { idToken }), 'configuration');
    }
    assert.equal(exchanges, 0);
    assert.deepEqual(await client.handleCallback(url, login), claims);
    assert.deepEqual(await client.handleCallback(url, login, { idToken: false }), claims);
    assert.deepEqual(await client.handleCallback(url, login, { idToken: undefined }), claims);
    assert.deepEqual(await client.handleCallback(url, login, { idToken: true }), { claims, idToken });
    await assert.rejects(client.handleCallback(url, { ...login, nonce: 'wrong' }, { idToken: true }),
        { name: 'IdentityError', code: 'invalid_token', message: 'Nonce mismatch.' });
});

test('client GitHub and Google complete through server handler', async t => {
    const x = await setup(t);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(options.redirect, 'manual');
        if (url.endsWith('/access_token')) return Response.json({ access_token: 'provider-token' });
        if (url.endsWith('/user')) return Response.json({ id: 42, login: 'person' });
        if (url.includes('/user/emails')) return Response.json([{ email: 'person@example.com', primary: true, verified: true }]);
        throw Error('Unexpected provider URL');
    });
    const github = await x.start();
    const started = await x.w.call(`/v1/auth/github/start?request_id=${github.request_id}`, { headers: { cookie: github.cookie } });
    const provider = new URL(callback(started));
    const completed = await x.w.call('/auth/github/callback?' + new URLSearchParams({ code: 'github-code', state: provider.searchParams.get('state') }), { headers: { cookie: github.cookie + '; ' + cookieJar(started) } });
    assert.equal((await x.client.handleCallback(callback(completed), github.login)).amr[0], 'github');
    t.mock.restoreAll();
    const fake = fakeGoogle(t, x.w), google = await x.start();
    const googleStart = await x.w.call(`/v1/auth/google/start?request_id=${google.request_id}`, { headers: { cookie: google.cookie } });
    fake.config.nonce = new URL(callback(googleStart)).searchParams.get('nonce');
    const result = await googleCallback(x.w, { url: new URL(callback(googleStart)), cookie: google.cookie + '; ' + cookieJar(googleStart) });
    assert.equal((await x.client.handleCallback(callback(result), google.login)).amr[0], 'google');
});

test('client SSO, disabled method and logout URL', async t => {
    const x = await setup(t), flow = await x.start(), signedIn = await x.magic(flow);
    const claims = await x.client.handleCallback(callback(signedIn), flow.login);
    const sso = await x.start(cookieJar(signedIn), { prompt: 'none' });
    assert.equal(sso.response.status, 303);
    assert.equal((await x.client.handleCallback(callback(sso.response), sso.login)).sub, claims.sub);
    x.w.env.DB.db.exec(`UPDATE clients SET sign_in_methods='["google"]' WHERE id='app'`);
    const refused = await x.start('', { method: 'email' });
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' });
    try { assert.equal((await x.w.post('/v1/auth/magic/request', { request_id: refused.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, refused.cookie)).status, 403); }
    finally { globalThis.fetch = original; }
    const logout = new URL(await x.client.logoutUrl({ postLogoutRedirectUri: 'https://app.example/bye', state: 'bye' }));
    assert.equal(logout.pathname, '/logout'); assert.equal(logout.searchParams.get('state'), 'bye');
    assert.equal((await x.w.call(logout.pathname + logout.search, { headers: { cookie: cookieJar(signedIn) } })).status, 200);
    const jar = cookieJar(signedIn), csrf = jar.match(/__Host-vi_csrf=([^;]+)/)[1];
    const posted = await x.w.call('/logout', { method: 'POST', headers: { origin: x.w.env.ISSUER, cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...Object.fromEntries(logout.searchParams), csrf }) });
    assert.equal(posted.status, 303);
    assert.equal(posted.headers.get('location'), 'https://app.example/bye?state=bye');
    assert.equal(x.w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});

test('client validates signature, claims, key refresh and logout event', async t => {
    const x = await setup(t);
    await x.client.startLogin();
    for (const claims of [{ aud: 'other' }, { nonce: 'swapped' }, { exp: 0 }, { nbf: Math.floor(Date.now()/1000) + 1000 }, { aud: ['app','other'], azp: 'other' }])
        await rejects(x.client.verifyIdToken(await signed(x.w, claims), { nonce: 'n' }), 'invalid_token');
    const good = await signed(x.w);
    assert.equal((await x.client.verifyIdToken(good, { nonce: 'n' })).sub, 'person');
    const parts = good.split('.'); parts[1] = Buffer.from(JSON.stringify({ aud: 'app' })).toString('base64url');
    await rejects(x.client.verifyIdToken(parts.join('.'), { nonce: 'n' }), 'invalid_token');
    for (const alg of ['none','HS256','RS256']) {
        const changed = [...good.split('.')]; changed[0] = Buffer.from(JSON.stringify({ alg, kid: 'x' })).toString('base64url');
        await rejects(x.client.verifyIdToken(changed.join('.'), { nonce: 'n' }), 'invalid_token');
    }
    const unknown = [...good.split('.')]; unknown[0] = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'unknown' })).toString('base64url');
    await rejects(x.client.verifyIdToken(unknown.join('.'), { nonce: 'n' }), 'invalid_token');
    assert.equal(x.jwksCalls, 2);
    await rejects(x.client.verifyIdToken(unknown.join('.'), { nonce: 'n' }), 'invalid_token');
    assert.equal(x.jwksCalls, 2);
    const token = await signed(x.w, { nonce: undefined, jti: 'unique', sid: 'session', events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }, { typ: 'logout+jwt' });
    const request = new Request('https://app.example/backchannel', { method: 'POST', body: new URLSearchParams({ logout_token: token }) });
    assert.deepEqual(await x.client.handleBackchannelLogout(request), { sub: 'person', sid: 'session', jti: 'unique' });
    await rejects(x.client.handleBackchannelLogout(new Request('https://app.example/backchannel', { method: 'POST', body: new URLSearchParams({ logout_token: good }) })), 'invalid_token');
});

test('client accepts a newly published signing key after unknown-kid refresh', async t => {
    const x = await setup(t);
    await x.client.verifyIdToken(await signed(x.w), { nonce: 'n' });
    assert.equal(x.jwksCalls, 1);
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey), kid = crypto.randomUUID();
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    x.w.env.DB.db.prepare('INSERT INTO signing_keys(generation,kid,public_jwk,sealed_jwk,created_at,activates_at) VALUES(2,?,?,?,?,?)')
        .run(kid, JSON.stringify(publicJwk), await seal(x.w.env, JSON.stringify(jwk), `oidc-signing-key:${kid}`), Date.now(), Date.now());
    forgetJwks(x.w.env); // The server memoises JWKS for a minute; real rotations publish an hour ahead.
    const token = await signed(x.w);
    assert.equal((await x.client.verifyIdToken(token, { nonce: 'n' })).sub, 'person');
    assert.equal(x.jwksCalls, 2);
});

test('client reports failed discovery through a typed error', async () => {
    const client = createClient({ issuer: 'https://id.example.com', clientId: 'app', redirectUri: 'https://app.example/callback', fetch: async () => { throw Error('offline'); } });
    await rejects(client.startLogin(), 'network');
});

test('client invitation and missing ID token', async t => {
    const x = await setup(t);
    assert.equal((await x.client.inviteEmail('friend@example.com')).accepted, true);
    const flow = await x.start();
    const response = await x.magic(flow);
    const broken = createClient({ issuer: x.w.env.ISSUER, clientId: 'app', clientSecret: 'secret', redirectUri: 'https://app.example/callback', fetch: async (url, init) => String(url).endsWith('/token') ? Response.json({ access_token: 'x' }) : x.w.call(new URL(url).pathname, init) });
    await rejects(broken.handleCallback(callback(response), flow.login), 'invalid_response');
});

test('vendored body hash matches header', async () => {
    const file = await readFile(new URL('../dist/imprim-client.mjs', import.meta.url), 'utf8');
    const [header, ...body] = file.split('\n');
    assert.match(header, /^\/\/ imprim-client 0\.8\.1 body-sha256 [a-f0-9]{64}/);
    assert.equal(header.split(' ').at(-1), createHash('sha256').update(body.join('\n')).digest('hex'));
});
