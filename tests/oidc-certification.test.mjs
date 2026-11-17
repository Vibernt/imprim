// OpenID Connect behaviour the certification suite exercises: classic apps without PKCE or nonce, id_token_hint,
// POST authorization requests, client_secret_post and the UserInfo body token. Each has its boundary tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, begin, basic, cookieJar, turnstile } from './support/world.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';

const classic = w => w.env.DB.db.exec("UPDATE clients SET classic_oidc='on' WHERE id='app'");
const codes = w => w.env.DB.db.prepare('SELECT count(*) AS n FROM codes').get().n;
const form = (code, extra = {}) => new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://app.example/callback', ...extra });
const tokenCall = (w, body, auth = basic()) => w.call('/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(auth ? { authorization: auth } : {}) }, body });
const claimsOf = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
// A magic-link sign-in that starts from an authorization request with these changes.
async function signIn(w, t, changes = {}, email = 'person@example.com', cookie = '') {
    turnstile(t);
    const flow = await begin(w, cookie, changes);
    await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email, turnstile: crypto.randomUUID() }, flow.cookie);
    await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const response = await w.post('/v1/auth/magic/verify', { token }, flow.cookie);
    const location = response.headers.get('location');
    return { response, cookie: cookieJar(response), code: location ? new URL(location).searchParams.get('code') : null };
}
const noPkce = { code_challenge: null, code_challenge_method: null };

test('a classic app signs in without PKCE or nonce, and its ID token carries no nonce', async t => {
    const w = await world(t);
    classic(w);
    const signed = await signIn(w, t, { ...noPkce, nonce: null });
    assert.ok(signed.code);
    const response = await tokenCall(w, form(signed.code));
    assert.equal(response.status, 200);
    const claims = claimsOf((await response.json()).id_token);
    assert.equal(claims.nonce, undefined);
    assert.equal(claims.aud, 'app');
});
test('a classic app that sends a nonce gets it back', async t => {
    const w = await world(t);
    classic(w);
    const signed = await signIn(w, t, noPkce);
    const response = await tokenCall(w, form(signed.code));
    assert.equal(claimsOf((await response.json()).id_token).nonce, 'rp-nonce');
});
test('a code issued without PKCE refuses a verifier, so PKCE cannot be half used', async t => {
    const w = await world(t);
    classic(w);
    const signed = await signIn(w, t, noPkce);
    const response = await tokenCall(w, form(signed.code, { code_verifier: w.verifier }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');
});
test('a classic app that started PKCE must finish it', async t => {
    const w = await world(t);
    classic(w);
    const signed = await signIn(w, t);
    const response = await tokenCall(w, form(signed.code));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');
});
for (const [name, changes] of Object.entries({
    'a challenge without its method': { code_challenge_method: null }, 'a method without its challenge': { code_challenge: null }, 'plain PKCE': { code_challenge_method: 'plain' },
    'an empty nonce': { ...noPkce, nonce: '' }, 'a missing state': { ...noPkce, state: null }
})) test(`a classic app is still refused ${name}`, async t => {
    const w = await world(t);
    classic(w);
    const response = await w.authorize(changes);
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'invalid_request');
});
test('without classic OpenID Connect, PKCE, nonce and claims stay required or refused', async t => {
    const w = await world(t);
    for (const changes of [noPkce, { nonce: null }, { claims: '{"id_token":{"name":{"essential":true}}}' }]) {
        const response = await w.authorize(changes);
        assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'invalid_request');
    }
    assert.equal(codes(w), 0);
});
test('a public app with the classic switch still needs PKCE', async t => {
    const w = await world(t);
    w.env.DB.db.exec("UPDATE clients SET classic_oidc='on', secret_hash=NULL WHERE id='app'");
    const response = await w.authorize(noPkce);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'invalid_request');
});
test('a classic app may send a claims request, which is ignored', async t => {
    const w = await world(t);
    classic(w);
    const response = await w.authorize({ ...noPkce, claims: '{"userinfo":{"name":{"essential":true}}}' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-request-id=/);
});
test('request objects and request_uri are refused with their own errors', async t => {
    const w = await world(t);
    for (const [name, error] of [['request', 'request_not_supported'], ['request_uri', 'request_uri_not_supported']]) {
        const response = await w.authorize({ [name]: 'eyJhbGciOiJub25lIn0.e30.' });
        assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), error);
    }
});
test('the classic switch is refused for a public client, in the seed script and the console', async t => {
    const config = { id: 'legacy', secret_hash: null, redirect_uris: ['https://legacy.example/cb'], sign_in_methods: ['email'], classic_oidc: 'on' };
    assert.throws(() => clientSeedSql(config), /confidential/);
    assert.match(clientSeedSql({ ...config, secret_hash: 'a'.repeat(64) }), /classic_oidc/);
    assert.throws(() => clientSeedSql({ ...config, secret_hash: 'a'.repeat(64), classic_oidc: 'yes' }), /classic_oidc/);
    const { saveClient } = await import('../apps/server/src/admin/clients.mjs');
    const w = await world(t);
    w.env.DB.db.exec("UPDATE clients SET secret_hash=NULL, backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    await assert.rejects(saveClient(w.env, 'admin@example.com', 'app', { classic_oidc: 'on', version: 0 }), /confidential app/);
    w.env.DB.db.exec(`UPDATE clients SET secret_hash='${'b'.repeat(64)}' WHERE id='app'`);
    const saved = await saveClient(w.env, 'admin@example.com', 'app', { classic_oidc: 'on', version: 0 });
    assert.equal(saved.client.classic_oidc, 'on');
});

test('id_token_hint with prompt=none returns a code for the hinted person', async t => {
    const w = await world(t), first = await login(w, t);
    const { id_token } = await (await w.exchange(first.code)).json();
    const response = await w.authorize({ prompt: 'none', id_token_hint: id_token }, first.cookie);
    const location = new URL(response.headers.get('location'));
    assert.ok(location.searchParams.get('code'));
    assert.equal(location.searchParams.get('error'), null);
});
test('id_token_hint for someone else returns login_required under prompt=none', async t => {
    const w = await world(t), a = await login(w, t, 'a@example.com');
    const { id_token } = await (await w.exchange(a.code)).json();
    const b = await login(w, t, 'b@example.com');
    const response = await w.authorize({ prompt: 'none', id_token_hint: id_token }, b.cookie);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'login_required');
});
test('id_token_hint for someone else cannot be finished by another account signing in', async t => {
    const w = await world(t), a = await login(w, t, 'a@example.com');
    const { id_token } = await (await w.exchange(a.code)).json();
    const before = codes(w);
    const b = await signIn(w, t, { id_token_hint: id_token }, 'b@example.com');
    assert.equal(b.code, null);
    assert.equal(b.response.status, 401);
    assert.equal(codes(w), before);
    // The hinted person can finish it.
    const again = await signIn(w, t, { id_token_hint: id_token }, 'a@example.com');
    assert.ok(again.code);
});
test('an expired id_token_hint still names the person', async t => {
    const w = await world(t), first = await login(w, t);
    const { id_token } = await (await w.exchange(first.code)).json();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3600000 });
    const response = await w.authorize({ prompt: 'none', id_token_hint: id_token, max_age: '99999' }, first.cookie);
    assert.ok(new URL(response.headers.get('location')).searchParams.get('code'));
});
test('id_token_hint is refused when forged, malformed or issued to another app', async t => {
    const w = await world(t), first = await login(w, t);
    const { id_token } = await (await w.exchange(first.code)).json();
    const [head, body, sig] = id_token.split('.');
    const forged = `${head}.${Buffer.from(JSON.stringify({ ...claimsOf(id_token), sub: 'someone-else' })).toString('base64url')}.${sig}`;
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${body}.`;
    for (const [hint, client] of [[forged, 'app'], [none, 'app'], ['not-a-token', 'app'], [id_token, 'other']]) {
        const response = await w.authorize({ prompt: 'none', id_token_hint: hint, client_id: client }, first.cookie);
        assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'invalid_request', hint.slice(0, 20));
    }
});

test('an authorization request may be POSTed as a form', async t => {
    const w = await world(t);
    const { challengeOf } = await import('../apps/server/src/lib/crypto.mjs');
    const body = new URLSearchParams({ client_id: 'app', redirect_uri: 'https://app.example/callback', response_type: 'code', scope: 'openid',
        state: 's', nonce: 'n', code_challenge: await challengeOf(w.verifier), code_challenge_method: 'S256' });
    const response = await w.call('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-request-id=/);
});
test('a POSTed authorization request needs a form body, and agents must use GET', async t => {
    const w = await world(t);
    const json = await w.call('/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"client_id":"app"}' });
    assert.equal(json.status, 415);
    const agent = await w.call('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'https://agent.example/client.json', resource: 'https://app.example/w/one/mcp' }) });
    assert.equal(agent.status, 400);
    const duplicate = await w.call('/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=app&client_id=other' });
    assert.equal(duplicate.status, 400);
});

test('client_secret_post authenticates at the token endpoint', async t => {
    const w = await world(t), signed = await login(w, t);
    const response = await tokenCall(w, form(signed.code, { code_verifier: w.verifier, client_id: 'app', client_secret: 'secret' }), null);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).id_token);
});
for (const [name, extra, auth] of [
    ['a wrong secret', { client_id: 'app', client_secret: 'wrong' }, null],
    ['a secret without a client id', { client_secret: 'secret' }, null],
    ['an unknown client', { client_id: 'nobody', client_secret: 'secret' }, null],
    ['both basic and post', { client_id: 'app', client_secret: 'secret' }, basic()]
]) test(`client_secret_post refuses ${name}`, async t => {
    const w = await world(t), signed = await login(w, t);
    const response = await tokenCall(w, form(signed.code, { code_verifier: w.verifier, ...extra }), auth);
    assert.equal(response.status, 401);
    assert.equal(codes(w), 1);
});
test('client_secret_post is not accepted at introspection', async t => {
    const w = await world(t);
    const response = await w.call('/introspect', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: 'x'.repeat(43), client_id: 'app', client_secret: 'secret' }) });
    assert.equal(response.status, 401);
});

test('UserInfo accepts the access token in a POST form body', async t => {
    const w = await world(t), signed = await login(w, t);
    const { access_token } = await (await w.exchange(signed.code)).json();
    const response = await w.call('/userinfo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ access_token }) });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).sub);
});
test('UserInfo refuses a token sent two ways, in the query, or malformed', async t => {
    const w = await world(t), signed = await login(w, t);
    const { access_token } = await (await w.exchange(signed.code)).json();
    const both = await w.call('/userinfo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${access_token}` }, body: new URLSearchParams({ access_token }) });
    assert.equal(both.status, 400);
    const query = await w.call(`/userinfo?access_token=${access_token}`);
    assert.equal(query.status, 401);
    const malformed = await w.call('/userinfo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'access_token=short' });
    assert.equal(malformed.status, 401);
});
test('discovery lists client_secret_post for the token endpoint only', async t => {
    const w = await world(t), doc = await (await w.call('/.well-known/openid-configuration')).json();
    assert.ok(doc.token_endpoint_auth_methods_supported.includes('client_secret_post'));
    assert.ok(!doc.introspection_endpoint_auth_methods_supported.includes('client_secret_post'));
    assert.equal(doc.claims_parameter_supported, false);
});

test('the conformance setup SQL gives the suite working classic clients and a password person', async t => {
    const { conformanceClient, planConfig, personSql, CLIENTS, SUITE } = await import('../scripts/conformance-setup.mjs');
    const { sha256 } = await import('../apps/server/src/lib/crypto.mjs');
    const w = await world(t), secrets = { 'oidf-basic': 'basic-secret', 'oidf-basic-2': 'basic-2-secret', 'oidf-post': 'post-secret' };
    for (const id of CLIENTS) w.env.DB.db.exec(clientSeedSql(conformanceClient(id, 'imprim-test', await sha256(secrets[id]))));
    w.env.DB.db.exec(await personSql('suite-person', 'suite@example.com', 'a long test password'));
    const plan = planConfig(w.env.ISSUER, 'imprim-test', secrets);
    assert.equal(plan.client_secret_post.client_id, 'oidf-post');
    const callback = `${SUITE}/test/a/imprim-test/callback`;
    // As the suite does: no PKCE, no nonce, then client_secret_post at the token endpoint.
    turnstile(t);
    const flow = await begin(w, '', { client_id: 'oidf-post', redirect_uri: callback, ...noPkce, nonce: null });
    const signed = await w.post('/v1/auth/password', { request_id: flow.request_id, email: 'suite@example.com', password: 'a long test password', turnstile: crypto.randomUUID() }, flow.cookie);
    assert.equal(signed.status, 200);
    const code = new URL((await signed.json()).redirect).searchParams.get('code');
    assert.ok(code);
    const response = await w.call('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: 'oidf-post', client_secret: 'post-secret' }) });
    assert.equal(response.status, 200);
    assert.equal(claimsOf((await response.json()).id_token).sub, 'suite-person');
    // The person is admitted to the test clients only, and only password sign-in is offered.
    const other = await begin(w, '', {});
    const refused = await w.post('/v1/auth/password', { request_id: other.request_id, email: 'suite@example.com', password: 'a long test password', turnstile: crypto.randomUUID() }, other.cookie);
    assert.notEqual(refused.status, 200);
});

test('max_age counts whole seconds, so a sign-in late in a second still meets max_age=1', async () => {
    const { withinMaxAge } = await import('../apps/server/src/oidc/requests.mjs');
    const signedIn = 1_800_000_000; // auth_time, rounded down from 1_800_000_000.950
    assert.equal(withinMaxAge(signedIn, 1, 1_800_000_001_150), true); // 0.2 s later
    assert.equal(withinMaxAge(signedIn, 1, 1_800_000_001_999), true);
    assert.equal(withinMaxAge(signedIn, 1, 1_800_000_002_000), false); // two whole seconds
    assert.equal(withinMaxAge(signedIn, 0, 1_800_000_000_999), true);
    assert.equal(withinMaxAge(signedIn, 0, 1_800_000_001_000), false);
});

test('acr_values demands a second factor only when the single-factor level is not acceptable', async () => {
    const { acrRequested } = await import('../apps/server/src/auth/mfa.mjs');
    assert.equal(acrRequested({ acr_values: 'urn:imprim:acr:mfa' }), true);
    assert.equal(acrRequested({ acr_values: 'urn:imprim:acr:mfa something-else' }), true);
    assert.equal(acrRequested({ acr_values: 'urn:imprim:acr:sf urn:imprim:acr:mfa' }), false);
    assert.equal(acrRequested({ acr_values: 'urn:imprim:acr:mfa urn:imprim:acr:sf' }), false);
    assert.equal(acrRequested({ acr_values: 'urn:imprim:acr:sf' }), false);
    assert.equal(acrRequested({ acr_values: null }), false);
});
test('a request accepting either level signs in with one factor and says which it got', async t => {
    const w = await world(t);
    const signed = await signIn(w, t, { acr_values: 'urn:imprim:acr:sf urn:imprim:acr:mfa' });
    assert.ok(signed.code);
    const claims = claimsOf((await (await w.exchange(signed.code)).json()).id_token);
    assert.equal(claims.acr, 'urn:imprim:acr:sf');
});
