// Machine identities (client_credentials + private_key_jwt), introspection, revocation and the app grant API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, basic, turnstile } from './support/world.mjs';
import { agentWorld, resource, metadataId, error } from './support/agents.mjs';
import { adminLogin } from './support/admin.mjs';
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function keyPair(kid = 'm1') {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { ...pair, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid } };
}
async function assertion(pair, clientId, claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'ES256', kid: pair.jwk.kid })}.${b64({ iss: clientId, sub: clientId, aud: 'https://id.example.com/token', exp: now + 120, jti: crypto.randomUUID(), ...claims })}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(sig).toString('base64url')}`;
}
const ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const form = (w, path, body, headers = {}) => w.call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
async function machineWorld(t) {
    const w = await agentWorld(t);
    const pair = await keyPair();
    w.env.DB.db.prepare(`INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,created,updated)
        VALUES('ci-bot','default','app','CI bot','ops@example.com',?,'["read"]','["https://app.example/w/team-one/"]',0,0)`).run(JSON.stringify({ keys: [pair.jwk] }));
    const token = async (changes = {}, claims = {}) => form(w, '/token', { grant_type: 'client_credentials', client_id: 'ci-bot', resource,
        client_assertion_type: ASSERTION, client_assertion: await assertion(pair, 'ci-bot', claims), ...changes });
    return { w, pair, token };
}
test('a service client gets a 60-second token for its app resource as service:<id>, with only its scopes', async t => {
    const { w, token } = await machineWorld(t);
    const response = await token();
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url'));
    assert.equal(claims.sub, 'service:ci-bot'); assert.equal(claims.aud, resource); assert.equal(claims.scope, 'read'); assert.equal(claims.exp - claims.iat, 60);
    const { createClient } = await import('../packages/imprim-client/index.mjs');
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', fetch: (url, init) => w.call(new URL(url).pathname, init) });
    assert.equal((await client.verifyAccessToken(body.access_token, { audience: resource })).sub, 'service:ci-bot');
    await error(await token({ scope: 'write' }), 'invalid_scope');
    await error(await token({ resource: 'https://app.example/w/team-two/mcp' }), 'invalid_target');
});
test('a service client must prove its key; a secret, a wrong key, a replayed assertion or a disabled client get nothing', async t => {
    const { w, pair, token } = await machineWorld(t);
    const signed = await assertion(pair, 'ci-bot');
    assert.equal((await form(w, '/token', { grant_type: 'client_credentials', client_id: 'ci-bot', resource })).status, 401);
    assert.equal((await form(w, '/token', { grant_type: 'client_credentials', client_id: 'ci-bot', resource, client_secret: 'x' })).status, 401);
    assert.equal((await form(w, '/token', { grant_type: 'client_credentials', client_id: 'ci-bot', resource, client_assertion_type: ASSERTION, client_assertion: signed })).status, 200);
    assert.equal((await form(w, '/token', { grant_type: 'client_credentials', client_id: 'ci-bot', resource, client_assertion_type: ASSERTION, client_assertion: signed })).status, 401, 'replay');
    const other = await keyPair();
    assert.equal((await form(w, '/token', { grant_type: 'client_credentials', client_id: 'ci-bot', resource, client_assertion_type: ASSERTION, client_assertion: await assertion(other, 'ci-bot') })).status, 401);
    w.env.DB.db.exec("UPDATE service_clients SET status='disabled'");
    assert.equal((await token()).status, 401);
});
test('introspection: an app sees live tokens for its own resources only; revoked grants and disabled services are inactive', async t => {
    const { w, token } = await machineWorld(t);
    const machine = (await (await token()).json()).access_token;
    const { tokens } = await w.grant();
    const ask = (tokenValue, auth = basic()) => form(w, '/introspect', { token: tokenValue }, { authorization: auth });
    const active = await (await ask(tokens.access_token)).json();
    assert.equal(active.active, true); assert.equal(active.client_id, metadataId); assert.equal(active.aud, resource);
    assert.equal((await (await ask(machine)).json()).sub, 'service:ci-bot');
    assert.equal((await (await ask(tokens.access_token, basic('other', 'secret'))).json()).active, false, 'another app learns nothing');
    assert.equal((await ask(tokens.access_token, basic('app', 'wrong'))).status, 401);
    assert.equal((await (await ask('not-a-token')).json()).active, false);
    w.env.DB.db.exec('UPDATE agent_grants SET revoked_at=1');
    assert.equal((await (await ask(tokens.access_token)).json()).active, false);
    w.env.DB.db.exec("UPDATE service_clients SET status='disabled'");
    assert.equal((await (await ask(machine)).json()).active, false);
});
test('revocation: an agent revokes its own grant; an app revokes grants on its resources; anything else is a silent no-op', async t => {
    const w = await agentWorld(t);
    const first = await w.grant();
    assert.equal((await form(w, '/revoke', { token: first.tokens.refresh_token, client_id: 'https://someone.else/client.json' })).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at, null);
    assert.equal((await form(w, '/revoke', { token: first.tokens.refresh_token, client_id: metadataId })).status, 200);
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    await error(await w.refresh(first.tokens.refresh_token), 'invalid_grant');
    const second = await w.grant();
    assert.equal((await form(w, '/revoke', { token: second.tokens.access_token }, { authorization: basic('other', 'secret') })).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants WHERE revoked_at IS NULL').get().n, 1);
    assert.equal((await form(w, '/revoke', { token: second.tokens.access_token }, { authorization: basic() })).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants WHERE revoked_at IS NULL').get().n, 0);
});
test('the app grant API lists and revokes agents on its own workspaces only', async t => {
    const w = await agentWorld(t);
    await w.grant();
    const list = await w.call('/v1/grants?' + new URLSearchParams({ resource }), { headers: { authorization: basic() } });
    const { grants } = await list.json();
    assert.equal(grants.length, 1); assert.equal(grants[0].agent, metadataId); assert.equal(grants[0].sub, w.user.id);
    assert.equal((await w.call('/v1/grants?' + new URLSearchParams({ resource }), { headers: { authorization: basic('other', 'secret') } })).status, 403);
    assert.equal((await w.call('/v1/grants?' + new URLSearchParams({ resource }))).status, 401);
    assert.equal((await form(w, '/v1/grants/revoke', { grant_id: grants[0].grant_id }, { authorization: basic('other', 'secret') })).status, 404);
    const revoked = await form(w, '/v1/grants/revoke', { grant_id: grants[0].grant_id }, { authorization: basic() });
    assert.equal(revoked.status, 200);
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='app_revoke'").get().n, 1);
});
test('admins create service clients with public keys, catalogue scopes and prefixes under the app', async t => {
    const w = await agentWorld(t); turnstile(t);
    const admin = await adminLogin(w), pair = await keyPair();
    const good = { id: 'deployer', app_id: 'app', name: 'Deployer', owner_email: 'ops@example.com', jwks: { keys: [pair.jwk] }, scopes: ['read'], resource_prefixes: ['https://app.example/w/team-one/'] };
    for (const bad of [{ scopes: ['admin'] }, { resource_prefixes: ['https://evil.example/'] }, { jwks: { keys: [{ ...pair.jwk, d: 'secret' }] } }, { id: 'X' }, { client_secret: 'x' }])
        assert.equal((await admin.post('services', { ...good, ...bad })).status, 400, JSON.stringify(bad));
    const created = await admin.post('services', good);
    assert.equal(created.status, 200, await created.clone().text());
    assert.equal((await admin.post('services', good)).status, 409);
    assert.equal((await (await admin.get('services')).json()).services[0].owner_email, 'ops@example.com');
    assert.equal((await admin.post('services/deployer', { id: 'renamed' })).status, 400);
    const edited = await admin.post('services/deployer', { name: 'Updated deployer', status: 'disabled' });
    assert.equal(edited.status, 200);
    const { service } = await edited.json();
    assert.deepEqual([service.name, service.status, service.scopes], ['Updated deployer', 'disabled', good.scopes]);
    assert.equal((await admin.post('services/deployer/delete')).status, 200);
    assert.deepEqual((await (await admin.get('services')).json()).services, []);
});
test('discovery lists introspection, revocation and client_credentials', async t => {
    const w = await world(t);
    const d = await (await w.call('/.well-known/openid-configuration')).json();
    assert.equal(d.introspection_endpoint, 'https://id.example.com/introspect');
    assert.equal(d.revocation_endpoint, 'https://id.example.com/revoke');
    assert.ok(d.grant_types_supported.includes('client_credentials'));
    assert.ok(d.token_endpoint_auth_methods_supported.includes('private_key_jwt'));
});
