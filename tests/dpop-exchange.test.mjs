// DPoP-bound agent tokens (RFC 9449) and token exchange between apps (RFC 8693).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, resource, metadataId, error } from './support/agents.mjs';
import { basic } from './support/world.mjs';
import { thumbprint } from '../apps/server/src/machines/dpop.mjs';
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function dpopKey() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwk = { kty, crv, x, y };
    const proof = async ({ htm = 'POST', htu = 'https://id.vibernt.ai/token', iat = Math.floor(Date.now() / 1000), jti = crypto.randomUUID(), accessToken, header = {} } = {}) => {
        const ath = accessToken ? Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))).toString('base64url') : undefined;
        const input = `${b64({ typ: 'dpop+jwt', alg: 'ES256', jwk, ...header })}.${b64({ htm, htu, iat, jti, ...(ath ? { ath } : {}) })}`;
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
        return `${input}.${Buffer.from(sig).toString('base64url')}`;
    };
    return { jwk, proof, jkt: await thumbprint(jwk) };
}
async function boundGrant(w, key) {
    const flow = await w.start(); const approved = await w.approve(flow);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    return w.form('/token', { grant_type: 'authorization_code', client_id: metadataId, resource, code, redirect_uri: 'http://127.0.0.1:4567/callback', code_verifier: w.verifier }, '', { dpop: await key.proof() });
}
test('a DPoP proof binds the agent grant: tokens carry cnf.jkt and every refresh needs the same key', async t => {
    const w = await agentWorld(t), key = await dpopKey();
    const issued = await boundGrant(w, key);
    assert.equal(issued.status, 200, await issued.clone().text());
    const tokens = await issued.json();
    assert.equal(tokens.token_type, 'DPoP');
    assert.equal(JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url')).cnf.jkt, key.jkt);
    assert.equal(w.env.DB.db.prepare('SELECT dpop_jkt FROM agent_grants').get().dpop_jkt, key.jkt);
    await error(await w.refresh(tokens.refresh_token), 'invalid_dpop_proof');
    const other = await dpopKey();
    await error(await w.form('/token', { grant_type: 'refresh_token', client_id: metadataId, resource, refresh_token: tokens.refresh_token }, '', { dpop: await other.proof() }), 'invalid_dpop_proof');
    const next = await w.form('/token', { grant_type: 'refresh_token', client_id: metadataId, resource, refresh_token: tokens.refresh_token }, '', { dpop: await key.proof() });
    assert.equal(next.status, 200, await next.clone().text());
});
test('DPoP proofs are refused for another URL or method, when stale, when replayed, or with a private or mismatched key', async t => {
    const w = await agentWorld(t), key = await dpopKey();
    const exchange = async dpop => {
        const flow = await w.start(); const approved = await w.approve(flow);
        const code = new URL(approved.headers.get('location')).searchParams.get('code');
        return w.form('/token', { grant_type: 'authorization_code', client_id: metadataId, resource, code, redirect_uri: 'http://127.0.0.1:4567/callback', code_verifier: w.verifier }, '', { dpop });
    };
    const reused = await key.proof();
    assert.equal((await exchange(reused)).status, 200);
    for (const dpop of [reused, await key.proof({ htu: 'https://id.vibernt.ai/other' }), await key.proof({ htm: 'GET' }), await key.proof({ iat: Math.floor(Date.now() / 1000) - 3600 }),
        await key.proof({ header: { jwk: { ...key.jwk, d: 'secret' } } }), await key.proof({ header: { alg: 'RS256' } }), 'not-a-proof'])
        await error(await exchange(dpop), 'invalid_dpop_proof');
});
test('an app can require DPoP for its agents', async t => {
    const w = await agentWorld(t);
    w.env.DB.db.exec("UPDATE clients SET agent_dpop='required' WHERE id='app'");
    const flow = await w.start(); const approved = await w.approve(flow);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    await error(await w.exchange(code), 'invalid_dpop_proof');
});
test('imprim-client checks the proof at the resource server: key, method, URL and the exact access token', async t => {
    const w = await agentWorld(t), key = await dpopKey();
    const tokens = await (await boundGrant(w, key)).json();
    const { createClient } = await import('../packages/imprim-client/index.mjs');
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', fetch: (url, init) => w.call(new URL(url).pathname, init) });
    const call = { method: 'POST', url: resource };
    const ok = await client.verifyAccessToken(tokens.access_token, { audience: resource, dpop: { ...call, proof: await key.proof({ htu: resource, accessToken: tokens.access_token }) } });
    assert.ok(ok.dpop_jti);
    await assert.rejects(client.verifyAccessToken(tokens.access_token, { audience: resource }), { code: 'invalid_dpop_proof' });
    await assert.rejects(client.verifyAccessToken(tokens.access_token, { audience: resource, dpop: { ...call, proof: await key.proof({ htu: resource, accessToken: 'another' }) } }), { code: 'invalid_dpop_proof' });
    const other = await dpopKey();
    await assert.rejects(client.verifyAccessToken(tokens.access_token, { audience: resource, dpop: { ...call, proof: await other.proof({ htu: resource, accessToken: tokens.access_token }) } }), { code: 'invalid_dpop_proof' });
    const bearer = (await w.grant()).tokens.access_token;
    await assert.rejects(client.verifyAccessToken(bearer, { audience: resource, requireDpop: true }), { code: 'invalid_token' });
});
const OTHER = 'https://other.example/w/team-one/mcp';
async function exchangeWorld(t) {
    const w = await agentWorld(t);
    w.env.DB.db.exec(`UPDATE clients SET agent_resource_prefixes='["https://other.example/w/"]', agent_scope_catalogue='{"read":"Read","admin":"Admin"}',
        token_exchange_from='{"app":["read"]}' WHERE id='other'`);
    const { tokens } = await w.grant();
    const exchange = (changes = {}, auth = basic()) => w.form('/token', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: tokens.access_token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', resource: OTHER, ...changes }, '', { authorization: auth });
    return { w, tokens, exchange };
}
test('token exchange: the app a token was issued to gets a token for another app that opted in, with act and the same grant', async t => {
    const { w, exchange } = await exchangeWorld(t);
    const response = await exchange();
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.issued_token_type, 'urn:ietf:params:oauth:token-type:access_token');
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url'));
    assert.equal(claims.aud, OTHER); assert.equal(claims.sub, w.user.id); assert.equal(claims.client_id, metadataId);
    assert.deepEqual(claims.act, { sub: 'app:app', client_id: 'app' });
    assert.equal(claims.scope, 'read');
    const live = await (await w.form('/introspect', { token: body.access_token }, '', { authorization: basic('other', 'secret') })).json();
    assert.equal(live.active, true);
    w.env.DB.db.exec('UPDATE agent_grants SET revoked_at=1');
    assert.equal((await (await w.form('/introspect', { token: body.access_token }, '', { authorization: basic('other', 'secret') })).json()).active, false, 'revoking the grant ends the chain');
});
test('token exchange is refused without opt-in, from another actor, beyond the allowed scopes, or for a revoked grant', async t => {
    const { w, exchange } = await exchangeWorld(t);
    await error(await exchange({ scope: 'admin' }), 'invalid_scope');
    await error(await exchange({}, basic('other', 'secret')), 'invalid_grant');
    await error(await exchange({ resource }), 'invalid_target');
    await error(await exchange({ subject_token_type: 'urn:ietf:params:oauth:token-type:id_token' }), 'invalid_request');
    w.env.DB.db.exec(`UPDATE clients SET token_exchange_from='{}' WHERE id='other'`);
    await error(await exchange(), 'unauthorized_client');
    w.env.DB.db.exec(`UPDATE clients SET token_exchange_from='{"app":["read"]}' WHERE id='other'; UPDATE agent_grants SET revoked_at=1`);
    await error(await exchange(), 'invalid_grant');
    assert.equal((await exchange({}, basic('app', 'wrong'))).status, 401);
});
test('discovery lists token exchange and DPoP algorithms', async t => {
    const w = await agentWorld(t);
    const d = await (await w.call('/.well-known/openid-configuration')).json();
    assert.ok(d.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:token-exchange'));
    assert.deepEqual(d.dpop_signing_alg_values_supported, ['ES256', 'RS256', 'EdDSA']);
});
