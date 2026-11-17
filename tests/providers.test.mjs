// Registry providers: generic OIDC, Microsoft (Entra ID) and Sign in with Apple, against fake providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { world, begin, cookieJar } from './support/world.mjs';
import { forgetRealms, validateRealmConfig } from '../apps/server/src/realms/realm.mjs';
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function fakeProvider(t, { type = 'oidc', issuer = 'https://sso.acme.test', tenant = 'common', tid = '11111111-1111-1111-1111-111111111111', claims = {}, header = {}, discoveryIssuer } = {}) {
    const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = { ...await crypto.subtle.exportKey('jwk', rsa.publicKey), kid: 'k1', use: 'sig' };
    const apple = type === 'apple' ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) : null;
    const base = type === 'microsoft' ? `https://login.microsoftonline.com/${tenant}/v2.0` : type === 'apple' ? 'https://appleid.apple.com' : issuer;
    const endpoints = type === 'apple' ? { authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys' }
        : { authorize: `${base}/authorize`, token: `${base}/token`, jwks: `${base}/keys` };
    const tokenIssuer = type === 'microsoft' ? `https://login.microsoftonline.com/${tid}/v2.0` : type === 'apple' ? 'https://appleid.apple.com' : issuer;
    const state = { authorize: null, tokenRequests: [], claims, header, appleKey: apple };
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
        url = String(url);
        assert.equal(init.redirect, 'manual');
        if (url.includes('challenges.cloudflare.com')) return Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' });
        if (url === `${base}/.well-known/openid-configuration`) return Response.json({ issuer: discoveryIssuer ?? (type === 'microsoft' ? 'https://login.microsoftonline.com/{tenantid}/v2.0' : issuer),
            authorization_endpoint: endpoints.authorize, token_endpoint: endpoints.token, jwks_uri: endpoints.jwks });
        if (url === endpoints.jwks) return Response.json({ keys: [jwk] });
        if (url === endpoints.token) {
            const form = new URLSearchParams(init.body); state.tokenRequests.push({ form, headers: init.headers });
            const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
            assert.equal(challenge, state.authorize.get('code_challenge'), 'PKCE verifier matches the challenge');
            if (form.get('code') !== 'good-code') return Response.json({ error: 'invalid_grant' }, { status: 400 });
            const now = Math.floor(Date.now() / 1000);
            const body = { iss: tokenIssuer, aud: 'client-123', sub: 'subject-1', email: 'person@example.com', email_verified: true, nonce: state.authorize.get('nonce'), iat: now, exp: now + 300,
                ...(type === 'microsoft' ? { tid } : {}), ...state.claims };
            const input = `${b64({ alg: 'RS256', kid: 'k1', ...state.header })}.${b64(body)}`;
            const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, new TextEncoder().encode(input))).toString('base64url');
            return Response.json({ id_token: `${input}.${sig}`, access_token: 'x', token_type: 'Bearer' });
        }
        throw new Error('Unexpected network request: ' + url);
    });
    return { state, apple, endpoints };
}
async function configure(w, id, provider, methods = [id]) {
    w.env.DB.db.prepare("UPDATE realms SET config=json_set(config,'$.providers.' || ?, json(?)) WHERE id='default'").run(id, JSON.stringify(provider));
    w.env.DB.db.prepare('UPDATE clients SET sign_in_methods=? WHERE id=?').run(JSON.stringify(methods), 'app');
    forgetRealms(w.env);
}
async function signIn(w, id, { code = 'good-code', method = 'GET', fake } = {}) {
    const flow = await begin(w);
    const start = await w.call(`/v1/auth/provider/${id}/start?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } });
    assert.equal(start.status, 303, await start.clone().text());
    const authorize = new URL(start.headers.get('location'));
    fake.state.authorize = authorize.searchParams;
    const jar = [flow.cookie, cookieJar(start)].join('; ');
    const params = { code, state: authorize.searchParams.get('state') };
    let callback;
    if (method === 'POST') {
        // A real browser sends only SameSite=None cookies on Apple's cross-site POST.
        const upstream = jar.split('; ').filter(c => c.startsWith('__Host-vi_up=')).join('; ');
        const posted = await w.call(`/login/provider/${id}/callback`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: upstream, origin: 'https://appleid.apple.com' }, body: new URLSearchParams(params) });
        assert.equal(posted.status, 303);
        callback = await w.call(new URL(posted.headers.get('location')).pathname + new URL(posted.headers.get('location')).search, { headers: { cookie: jar } });
    } else callback = await w.call(`/login/provider/${id}/callback?${new URLSearchParams(params)}`, { headers: { cookie: jar } });
    return { start, authorize, jar, callback, params };
}
const acme = { type: 'oidc', issuer: 'https://sso.acme.test', client_id: 'client-123', client_secret: { env: 'ACME_SECRET' }, name: 'Acme SSO' };
test('a generic OIDC provider signs in with PKCE, state and nonce; its email is a provider claim, not mailbox proof', async t => {
    const w = await world(t); w.env.ACME_SECRET = 'shh';
    const fake = await fakeProvider(t);
    await configure(w, 'acme', acme);
    assert.match(await (await w.authorize()).text(), /Sign in with Acme SSO/);
    const { authorize, callback } = await signIn(w, 'acme', { fake });
    assert.equal(authorize.origin + authorize.pathname, 'https://sso.acme.test/authorize');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.ok(new URL(callback.headers.get('location')).searchParams.get('code'));
    assert.equal(fake.state.tokenRequests[0].headers.authorization, 'Basic ' + btoa('client-123:shh'));
    const user = w.env.DB.db.prepare('SELECT * FROM users').get();
    assert.equal(user.email_verified, 0, 'not authoritative without trusted_domains');
    assert.equal(w.env.DB.db.prepare('SELECT provider FROM user_identities').get().provider, 'acme');
});
test('trusted_domains makes the provider authoritative: it may link an existing account and admit by domain', async t => {
    const w = await world(t, 'invited'); w.env.ACME_SECRET = 'shh';
    w.env.DB.db.exec(`UPDATE clients SET allowed_domains='["example.com"]' WHERE id='app'; INSERT INTO users(id,realm_id,email,email_verified,created) VALUES('old','default','person@example.com',1,0)`);
    const fake = await fakeProvider(t);
    await configure(w, 'acme', { ...acme, trusted_domains: ['example.com'] });
    const { callback } = await signIn(w, 'acme', { fake });
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id, 'old');
});
for (const [name, change] of [['wrong issuer', { claims: { iss: 'https://evil.example' } }], ['wrong audience', { claims: { aud: 'someone-else' } }],
    ['wrong nonce', { claims: { nonce: 'x'.repeat(43) } }], ['expired', { claims: { exp: 1 } }], ['unverified email', { claims: { email_verified: false } }],
    ['unknown key', { header: { kid: 'nope' } }], ['alg none', { header: { alg: 'none' } }], ['no email', { claims: { email: undefined } }]])
    test(`a provider ID token is refused: ${name}`, async t => {
        const w = await world(t); w.env.ACME_SECRET = 'shh';
        const fake = await fakeProvider(t, change);
        await configure(w, 'acme', acme);
        const { callback } = await signIn(w, 'acme', { fake });
        assert.ok([401, 403].includes(callback.status), `${name}: ${callback.status}`);
        assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    });
test('provider state is single-use and browser-bound; discovery must name the configured issuer; unconfigured or disallowed providers are refused', async t => {
    const w = await world(t); w.env.ACME_SECRET = 'shh';
    const fake = await fakeProvider(t);
    await configure(w, 'acme', acme);
    const { params, jar, callback } = await signIn(w, 'acme', { fake });
    assert.equal(callback.status, 303);
    assert.equal((await w.call(`/login/provider/acme/callback?${new URLSearchParams(params)}`, { headers: { cookie: jar } })).status, 401, 'replay');
    const other = await signIn(w, 'acme', { fake, code: 'bad-code' });
    assert.equal(other.callback.status, 502);
    const flow = await begin(w);
    assert.equal((await w.call(`/v1/auth/provider/ghost/start?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } })).status, 403, 'not an allowed method');
    w.env.DB.db.prepare("UPDATE clients SET sign_in_methods='[\"ghost\"]' WHERE id='app'").run();
    const flow2 = await begin(w);
    assert.equal((await w.call(`/v1/auth/provider/ghost/start?request_id=${flow2.request_id}`, { headers: { cookie: flow2.cookie } })).status, 503, 'not configured');
});
test('a provider whose discovery names another issuer is refused', async t => {
    const w = await world(t); w.env.ACME_SECRET = 'shh';
    await fakeProvider(t, { discoveryIssuer: 'https://evil.example' });
    await configure(w, 'acme', acme);
    const flow = await begin(w);
    assert.equal((await w.call(`/v1/auth/provider/acme/start?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } })).status, 502);
});
test('Microsoft: the issuer is checked against the token tenant, and a pinned tenant must match', async t => {
    const w = await world(t); w.env.MS_SECRET = 'shh';
    const fake = await fakeProvider(t, { type: 'microsoft' });
    await configure(w, 'microsoft', { type: 'microsoft', client_id: 'client-123', client_secret: { env: 'MS_SECRET' }, name: 'Microsoft' });
    const ok = await signIn(w, 'microsoft', { fake });
    assert.equal(ok.callback.status, 303, await ok.callback.clone().text());
    assert.equal(ok.authorize.origin + ok.authorize.pathname, 'https://login.microsoftonline.com/common/v2.0/authorize');
    assert.equal(fake.state.tokenRequests[0].form.get('client_secret'), 'shh');
    fake.state.claims = { iss: 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0' };
    assert.equal((await signIn(w, 'microsoft', { fake })).callback.status, 401, 'issuer must match the token tid');
});
test('Microsoft with a pinned tenant refuses another tenant', async t => {
    const w = await world(t); w.env.MS_SECRET = 'shh';
    const fake = await fakeProvider(t, { type: 'microsoft', tenant: '33333333-3333-3333-3333-333333333333' });
    await configure(w, 'microsoft', { type: 'microsoft', tenant: '33333333-3333-3333-3333-333333333333', client_id: 'client-123', client_secret: { env: 'MS_SECRET' } });
    assert.equal((await signIn(w, 'microsoft', { fake })).callback.status, 401);
});
test('Apple: form_post callback with a SameSite=None state cookie and an ES256 client secret', async t => {
    const w = await world(t);
    const fake = await fakeProvider(t, { type: 'apple', claims: { email_verified: 'true' } });
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', fake.apple.privateKey)).toString('base64');
    w.env.APPLE_KEY = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;
    await configure(w, 'apple', { type: 'apple', client_id: 'client-123', team_id: 'TEAM123', key_id: 'KEY123', private_key: { env: 'APPLE_KEY' }, name: 'Apple' });
    const { start, authorize, callback } = await signIn(w, 'apple', { fake, method: 'POST' });
    assert.match(start.headers.getSetCookie().join(), /__Host-vi_up=[^;]+;.*SameSite=None/);
    assert.equal(authorize.searchParams.get('response_mode'), 'form_post');
    assert.equal(callback.status, 303, await callback.clone().text());
    const secret = fake.state.tokenRequests[0].form.get('client_secret').split('.');
    const header = JSON.parse(Buffer.from(secret[0], 'base64url')), claims = JSON.parse(Buffer.from(secret[1], 'base64url'));
    assert.deepEqual([header.alg, header.kid, claims.iss, claims.sub, claims.aud], ['ES256', 'KEY123', 'TEAM123', 'client-123', 'https://appleid.apple.com']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, fake.apple.publicKey, Buffer.from(secret[2], 'base64url'), new TextEncoder().encode(`${secret[0]}.${secret[1]}`)));
});
test('realm config refuses literal provider secrets, unknown types and fields, and reserved ids', () => {
    for (const providers of [{ acme: { type: 'oidc', issuer: 'https://x.test', client_secret: 'plain' } }, { acme: { type: 'saml' } }, { acme: { type: 'oidc', issuer: 'http://x.test' } },
        { password: { type: 'oidc', issuer: 'https://x.test' } }, { acme: { type: 'oidc', issuer: 'https://x.test', colour: 'red' } }, { apple: { type: 'apple', private_key: 'pem' } },
        { ms: { type: 'microsoft', tenant: 'everyone' } }, { acme: { type: 'oidc', issuer: 'https://x.test', trusted_domains: ['*.x.test'] } }])
        assert.throws(() => validateRealmConfig({ providers }), error => error.code === 'realm_config', JSON.stringify(providers));
    assert.ok(validateRealmConfig({ providers: { acme: { ...acme, trusted_domains: ['acme.test'] }, github: { client_id: 'x', client_secret: { env: 'GH' } } } }));
});

// Review findings on the provider registry.
test('review 1: an unvouched Microsoft email never claims an invitation (nOAuth)', async t => {
    const w = await world(t, 'invited'); w.env.MS_SECRET = 'shh';
    w.env.DB.db.prepare("INSERT INTO invitations VALUES('app','person@example.com',?)").run(Date.now() + 60000);
    const fake = await fakeProvider(t, { type: 'microsoft', claims: { email_verified: undefined } });
    await configure(w, 'microsoft', { type: 'microsoft', client_id: 'client-123', client_secret: { env: 'MS_SECRET' } });
    assert.equal((await signIn(w, 'microsoft', { fake })).callback.status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM client_admissions').get().n, 0);
    fake.state.claims = { email_verified: undefined, xms_edov: true };
    assert.equal((await signIn(w, 'microsoft', { fake })).callback.status, 303, 'a tenant-verified domain may use the invitation');
});
test('review 1: a pinned Microsoft tenant with trusted_domains is authoritative without email_verified', async t => {
    const w = await world(t, 'invited'); w.env.MS_SECRET = 'shh';
    w.env.DB.db.exec(`UPDATE clients SET allowed_domains='["example.com"]' WHERE id='app'`);
    const tenant = '11111111-1111-1111-1111-111111111111';
    const fake = await fakeProvider(t, { type: 'microsoft', tenant, claims: { email_verified: undefined } });
    await configure(w, 'microsoft', { type: 'microsoft', tenant, client_id: 'client-123', client_secret: { env: 'MS_SECRET' }, trusted_domains: ['example.com'] });
    assert.equal((await signIn(w, 'microsoft', { fake })).callback.status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT email_verified FROM users').get().email_verified, 1);
});
