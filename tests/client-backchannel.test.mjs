import { forgetJwks } from '../apps/server/src/oidc/keys.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../packages/imprim-client/index.mjs';
import { world } from './support/world.mjs';
import { signAgentJwt } from '../apps/server/src/agents/grants.mjs';
const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout';
const revokeEvent = 'https://id.example.com/events/agent-revoked'; // issuer-relative: ${iss}/events/agent-revoked
const resource = 'https://app.example/w/team/mcp';
async function fixture(t) {
    const w = await world(t);
    let jwksCalls = 0;
    const options = { issuer: w.env.ISSUER, clientId: 'app', resourcePrefixes: ['https://app.example/w/'], fetch: url => {
        if (new URL(url).pathname.endsWith('jwks.json')) jwksCalls++;
        return w.call(new URL(url).pathname);
    } };
    const client = sdk.createClient(options), now = Math.floor(Date.now() / 1000);
    const claims = { iss: w.env.ISSUER, aud: 'app', sub: 'person', jti: 'event', iat: now, exp: now + 300,
        grant_id: 'grant', resource, events: { [revokeEvent]: {} } };
    const sign = (patch = {}, typ = 'secevent+jwt') => signAgentJwt(w.env, { ...claims, ...patch }, typ);
    return { w, client, options, claims, sign, get jwksCalls() { return jwksCalls; } };
}
const invalid = promise => assert.rejects(promise, e => e.code === 'invalid_token');

test('revocation verifier has exact claims, named export and a 900-second lifetime cap', async t => {
    const x = await fixture(t), token = await x.sign();
    const expected = { sub: 'person', jti: 'event', grantId: 'grant', resource, iat: x.claims.iat, exp: x.claims.exp };
    assert.deepEqual(await x.client.verifyRevocationToken(token), expected);
    assert.deepEqual(await sdk.verifyRevocationToken(token, x.options), expected);
    assert.equal((await x.client.verifyRevocationToken(await x.sign({ exp: x.claims.iat + 900 }))).exp, x.claims.iat + 900);
});

const cases = {
    audience: { aud: 'other' }, 'array audience': { aud: ['app'] }, issuer: { iss: 'https://evil.example' },
    expired: { iat: 1, exp: 301 }, lifetime: { exp: 'long' }, 'too long': { exp: 'too-long' },
    'missing event': { events: undefined }, 'wrong event': { events: { nope: {} } },
    'extra event': { events: { [revokeEvent]: {}, extra: {} } }, 'event payload': { events: { [revokeEvent]: { x: 1 } } },
    'missing grant': { grant_id: undefined }, 'missing resource': { resource: undefined }, 'missing subject': { sub: undefined },
    'missing jti': { jti: undefined }, 'outside prefixes': { resource: 'https://other.example/w/team/mcp' },
    'prefix sibling': { resource: 'https://app.example/wrong/mcp' }, 'encoded slash': { resource: 'https://app.example/w/a%2fb' },
    'resource query': { resource: resource + '?x=1' }, nonce: { nonce: 'n' }, future: { iat: 'future' },
    'fractional time': { iat: 1.5 }, 'inverted time': { exp: 'inverted' }
};
for (const [name, patch] of Object.entries(cases)) test(`revocation refuses ${name}`, async t => {
    const x = await fixture(t), value = { ...patch };
    if (value.exp === 'too-long') value.exp = x.claims.iat + 901;
    if (value.exp === 'inverted') value.exp = x.claims.iat;
    if (value.iat === 'future') value.iat = Math.floor(Date.now() / 1000) + 120; // well past the 60-second skew, however long the test took
    await invalid(x.client.verifyRevocationToken(await x.sign(value)));
});

test('back-channel types cannot be interchanged; strict logout type, time and no nonce', async t => {
    const x = await fixture(t), revocation = await x.sign();
    const patch = { events: { [logoutEvent]: {} }, grant_id: undefined, resource: undefined, exp: x.claims.iat + 120, sid: 'session' };
    const logout = await x.sign(patch, 'logout+jwt');
    assert.equal((await x.client.verifyLogoutToken(logout)).sid, 'session');
    await invalid(x.client.verifyRevocationToken(logout));
    await invalid(x.client.verifyLogoutToken(revocation));
    for (const typ of ['JWT','at+jwt','revocation+jwt']) await invalid(x.client.verifyLogoutToken(await x.sign(patch, typ)));
    for (const bad of [{ nonce: 'x' }, { exp: x.claims.iat + 901 }, { sub: undefined, sid: undefined }, { events: { [logoutEvent]: {}, extra: {} } }])
        await invalid(x.client.verifyLogoutToken(await x.sign({ ...patch, ...bad }, 'logout+jwt')));
    await invalid(x.client.verifyRevocationToken(await x.sign({}, 'revocation+jwt')));
});

test('signature tampering fails and unknown kid refreshes once, then fails closed', async t => {
    const x = await fixture(t), token = await x.sign();
    await x.client.verifyRevocationToken(token);
    const parts = token.split('.');
    const forged = [...parts]; forged[1] = Buffer.from(JSON.stringify({ ...x.claims, sub: 'attacker' })).toString('base64url');
    await invalid(x.client.verifyRevocationToken(forged.join('.')));
    const header = JSON.parse(Buffer.from(parts[0], 'base64url')); header.kid = 'unknown';
    parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url');
    await invalid(x.client.verifyRevocationToken(parts.join('.'))); assert.equal(x.jwksCalls, 2);
    await invalid(x.client.verifyRevocationToken(parts.join('.'))); assert.equal(x.jwksCalls, 2);
});

test('form dispatcher rejects missing, duplicate, mixed and file fields and preserves old handlers', async t => {
    const x = await fixture(t), token = await x.sign(), form = new URLSearchParams({ revocation_token: token });
    assert.equal((await x.client.verifyBackchannel(form)).kind, 'revocation');
    assert.equal((await sdk.verifyBackchannel(form, x.options)).claims.grantId, 'grant');
    const request = () => new Request('https://app.example/backchannel', { method: 'POST', body: form });
    assert.equal((await x.client.handleAgentRevocation(request())).grant_id, 'grant');
    for (const body of [new URLSearchParams(), new URLSearchParams([['revocation_token', token], ['revocation_token', token]]),
        new URLSearchParams({ revocation_token: token, logout_token: token })])
        await assert.rejects(x.client.verifyBackchannel(body), e => e.code === 'invalid_response');
    const file = new FormData(); file.set('revocation_token', new Blob(['token']));
    await assert.rejects(x.client.verifyBackchannel(file), e => e.code === 'invalid_response');
    await assert.rejects(x.client.handleAgentRevocation(new Request('https://app.example/backchannel?revocation_token=x')), e => e.code === 'invalid_response');
});

test('revocation accepts a newly published kid after exactly one refresh', async t => {
    const x = await fixture(t);
    await x.client.verifyRevocationToken(await x.sign());
    const { seal } = await import('../apps/server/src/lib/crypto.mjs');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey), kid = crypto.randomUUID();
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    x.w.env.DB.db.prepare('INSERT INTO signing_keys(generation,kid,public_jwk,sealed_jwk,created_at,activates_at) VALUES(2,?,?,?,?,?)')
        .run(kid, JSON.stringify(publicJwk), await seal(x.w.env, JSON.stringify(jwk), `oidc-signing-key:${kid}`), Date.now(), Date.now());
    forgetJwks(x.w.env); // The server memoises JWKS for a minute; real rotations publish an hour ahead.
    const token = await x.sign();
    assert.equal((await x.client.verifyRevocationToken(token)).grantId, 'grant');
    assert.equal(x.jwksCalls, 2);
    await x.client.verifyRevocationToken(token); assert.equal(x.jwksCalls, 2);
});

test('clock skew is bounded, expiry is exact, and verifier-only clients cannot start login', async t => {
    const x = await fixture(t);
    const token = await x.sign({ iat: x.claims.iat + 60 });
    assert.equal((await x.client.verifyRevocationToken(token)).iat, x.claims.iat + 60);
    await invalid(x.client.verifyRevocationToken(token, { clockSkewSeconds: 0 }));
    for (const clockSkewSeconds of [-1,61,1.5,Infinity,'60'])
        await assert.rejects(x.client.verifyRevocationToken(token, { clockSkewSeconds }), e => e.code === 'configuration');
    const ordinary = await x.sign();
    t.mock.method(Date, 'now', () => x.claims.exp * 1000);
    await invalid(x.client.verifyRevocationToken(ordinary));
    await assert.rejects(x.client.startLogin(), e => e.code === 'configuration');
    await assert.rejects(x.client.handleCallback('https://app.example/callback'), e => e.code === 'configuration');
});

test('prefix configuration is validated, copied and cannot be widened through verifier options', async t => {
    const x = await fixture(t), token = await x.sign();
    for (const resourcePrefixes of ['https://app.example/w/', [null], ['http://app.example/w/'], ['https://app.example/w/?q=x']])
        assert.throws(() => sdk.createClient({ ...x.options, resourcePrefixes }), e => e.code === 'configuration');
    await invalid(sdk.createClient({ ...x.options, resourcePrefixes: [] }).verifyRevocationToken(token));
    assert.equal((await sdk.createClient({ ...x.options, resourcePrefixes: [resource] }).verifyRevocationToken(token)).resource, resource);
    assert.equal((await sdk.createClient({ ...x.options, resourcePrefixes: undefined }).verifyRevocationToken(token)).resource, resource);
    x.options.resourcePrefixes.push('https://other.example/w/');
    await invalid(x.client.verifyRevocationToken(await x.sign({ resource: 'https://other.example/w/team/mcp' }), { resourcePrefixes: ['https://other.example/w/'] }));
});

test('logout dispatch returns the logout shape; mixed forms fail through old handlers too', async t => {
    const x = await fixture(t), token = await x.sign({ events: { [logoutEvent]: {} }, sid: 'sid', exp: x.claims.iat + 120 }, 'logout+jwt');
    const form = new URLSearchParams({ logout_token: token });
    assert.deepEqual(await x.client.verifyBackchannel(form), { kind: 'logout', claims: { sub: 'person', sid: 'sid', jti: 'event', iat: x.claims.iat, exp: x.claims.iat + 120 } });
    assert.equal((await sdk.verifyLogoutToken(token, x.options)).jti, 'event');
    form.set('revocation_token', await x.sign());
    await assert.rejects(x.client.handleBackchannelLogout(new Request('https://app.example/backchannel', { method: 'POST', body: form })), e => e.code === 'invalid_response');
});
