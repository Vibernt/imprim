import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, wwwAuthenticate, IdentityError } from '../packages/imprim-client/index.mjs';
import { agentWorld, resource } from './support/agents.mjs';
import { signAgentJwt } from '../apps/server/src/agents/grants.mjs';
import { readFile } from 'node:fs/promises';
function client(w, create = createClient) {
    return create({ issuer: w.env.ISSUER, clientId: 'app', redirectUri: 'https://app.example/callback', fetch: (url, init) => w.call(new URL(url).pathname, init) });
}
const rejects = promise => assert.rejects(promise, e => e instanceof IdentityError && e.code === 'invalid_token');

test('access verifier rejects signed wrong audience, token types, issuer, times and missing claims', async t => {
    const w = await agentWorld(t), c = client(w), { tokens } = await w.grant();
    const claims = await c.verifyAccessToken(tokens.access_token, { audience: resource });
    const cases = [{ aud: 'https://app.example/w/another/mcp' }, { aud: [resource] }, { iss: 'https://evil.example' }, { sub: '' }, { client_id: '' }, { grant_id: '' }, { jti: '' }, { scope: 'read\nwrite' }, { exp: Math.floor(Date.now()/1000) }, { exp: claims.iat + 901 }, { iat: claims.iat + 1000 }, { iat: 1.5 }, { nbf: claims.iat + 1000 }];
    for (const patch of cases) await rejects(c.verifyAccessToken(await signAgentJwt(w.env, { ...claims, ...patch }), { audience: resource }));
    await rejects(c.verifyAccessToken(await signAgentJwt(w.env, claims, 'JWT'), { audience: resource }));
    await rejects(c.verifyIdToken(tokens.access_token, { nonce: 'nonce' }));
    await assert.rejects(c.verifyAccessToken(tokens.access_token, {}), /resource URL/);
    const pieces = tokens.access_token.split('.');
    for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'ES256', kid: 'x', jku: 'https://evil.example/jwks' }]) {
        const forged = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + pieces.slice(1).join('.');
        await rejects(c.verifyAccessToken(forged, { audience: resource }));
    }
    const altered = [...pieces]; altered[1] = Buffer.from(JSON.stringify({ ...claims, scope: 'write' })).toString('base64url');
    await rejects(c.verifyAccessToken(altered.join('.'), { audience: resource }));
});

test('resource metadata and challenge helpers reject unsafe inputs', async t => {
    const w = await agentWorld(t), c = client(w);
    assert.deepEqual(c.protectedResourceMetadata({ resource, scopes: ['read'] }), { resource, authorization_servers: [w.env.ISSUER], scopes_supported: ['read'], bearer_methods_supported: ['header'] });
    assert.equal(c.wwwAuthenticate({ resourceMetadataUrl: 'https://app.example/meta', error: 'invalid_token' }), 'Bearer resource_metadata="https://app.example/meta", error="invalid_token"');
    for (const url of ['http://app.example/meta', 'https://app.example/meta"', 'https://user:pw@app.example/meta', 'https://app.example/meta\r\nX: value', 'https://app.example/meta#x'])
        assert.throws(() => wwwAuthenticate({ resourceMetadataUrl: url }));
    assert.throws(() => wwwAuthenticate({ resourceMetadataUrl: 'https://app.example/meta', error: 'anything' }));
    assert.throws(() => c.protectedResourceMetadata({ resource, scopes: ['bad scope'] }));
    assert.throws(() => c.protectedResourceMetadata({ resource, scopes: ['read','read'] }));
});

test('vendored artifact matches modular sources and verifies a real server access token', async t => {
    const w = await agentWorld(t), vendor = await import('../dist/imprim-client.mjs');
    const modules = ['resources', 'backchannel', 'jwt', 'dpop', 'workspaces', 'index'];
    const sources = await Promise.all(modules.map(name => readFile(new URL(`../packages/imprim-client/${name}.mjs`, import.meta.url), 'utf8')));
    const body = sources.map((source, index) => {
        const stripped = source.replace(/^import .*from '\.\/[^']+';\n/gm, '');
        return index === modules.length - 1 ? stripped : stripped.replace(/^export /gm, '');
    }).join('\n');
    const artifact = await readFile(new URL('../dist/imprim-client.mjs', import.meta.url), 'utf8');
    assert.equal(artifact.slice(artifact.indexOf('\n') + 1), body);
    const { tokens } = await w.grant();
    assert.equal((await client(w, vendor.createClient).verifyAccessToken(tokens.access_token, { audience: resource })).sub, w.user.id);
    assert.match(vendor.wwwAuthenticate({ resourceMetadataUrl: 'https://app.example/meta' }), /^Bearer /);
});

for (const field of ['iat','nbf']) test(`access ${field} permits bounded configurable future skew but expiry stays strict`, async t => {
    const w = await agentWorld(t), c = client(w), { tokens } = await w.grant();
    const claims = await c.verifyAccessToken(tokens.access_token, { audience: resource });
    const now = claims.iat; t.mock.method(Date, 'now', () => now * 1000);
    const token = async offset => signAgentJwt(w.env, { ...claims, [field]: now + offset, exp: now + (field === 'iat' ? offset : 0) + 60 });
    assert.equal((await c.verifyAccessToken(await token(60), { audience: resource })).sub, w.user.id);
    await rejects(c.verifyAccessToken(await token(61), { audience: resource }));
    await rejects(c.verifyAccessToken(await token(1), { audience: resource, clockSkewSeconds: 0 }));
    assert.equal((await c.verifyAccessToken(await token(5), { audience: resource, clockSkewSeconds: 5 })).sub, w.user.id);
    await rejects(c.verifyAccessToken(await token(6), { audience: resource, clockSkewSeconds: 5 }));
    for (const skew of [-1,61,0.5,'60',null]) await assert.rejects(c.verifyAccessToken(tokens.access_token, { audience: resource, clockSkewSeconds: skew }), e => e.code === 'configuration');
    t.mock.method(Date, 'now', () => claims.exp * 1000);
    await rejects(c.verifyAccessToken(tokens.access_token, { audience: resource, clockSkewSeconds: 60 }));
});
