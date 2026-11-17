// The MCP probe example (examples/mcp-probe) against the real Imprim Worker: challenge, metadata, a real agent
// token, and the trust boundaries it must hold (audience, scope, revocation, DPoP scheme, forged events, logs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, resource } from './support/agents.mjs';
import { d1Database } from './support/sqlite.mjs';
import probe from '../examples/mcp-probe/src/worker.mjs';
import { probeClient } from '../examples/mcp-probe/setup.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';
import { queue } from '../apps/server/src/services/maintenance.mjs';

const metadataUrl = 'https://app.example/.well-known/oauth-protected-resource/w/team-one/mcp';

async function probeWorld(t, settings = {}) {
    const w = await agentWorld(t);
    const DB = d1Database(new URL('../examples/mcp-probe/migrations/', import.meta.url));
    t.after(() => DB.db.close());
    const env = { ORIGIN: 'https://app.example', ISSUER: w.env.ISSUER, CLIENT_ID: 'app', WORKSPACES: 'team-one,team-two', SCOPE: 'read', DB,
        IDENTITY_FETCH: (url, init) => { const u = new URL(url); return w.call(u.pathname + u.search, init); }, ...settings };
    const lines = [];
    t.mock.method(console, 'log', line => lines.push(String(line)));
    const call = (url, init = {}) => probe.fetch(new Request(url, init), env);
    const rpc = (token, method, params = {}, { id = 1, url = resource, scheme = 'Bearer', headers = {} } = {}) => call(url, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `${scheme} ${token}` } : {}), ...headers },
        body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }) });
    return { w, env, DB, lines, call, rpc };
}

test('the probe challenges, serves resource metadata, and answers whoami for a real agent token', async t => {
    const p = await probeWorld(t), { tokens } = await p.w.grant();
    const challenge = await p.rpc(null, 'initialize');
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get('www-authenticate'), `Bearer resource_metadata="${metadataUrl}"`);
    // A client that opens with GET still gets the challenge, not a 405.
    assert.equal((await p.call(resource)).status, 401);
    const metadata = await (await p.call(metadataUrl)).json();
    assert.deepEqual(metadata, { resource, authorization_servers: [p.w.env.ISSUER], scopes_supported: ['read'], bearer_methods_supported: ['header'] });

    const opened = await (await p.rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18' })).json();
    assert.equal(opened.result.protocolVersion, '2025-06-18');
    assert.equal((await p.rpc(tokens.access_token, 'notifications/initialized', {}, { id: null })).status, 202);
    const listed = await (await p.rpc(tokens.access_token, 'tools/list', {}, { id: 2 })).json();
    assert.deepEqual(listed.result.tools.map(x => x.name), ['whoami']);
    const called = await (await p.rpc(tokens.access_token, 'tools/call', { name: 'whoami' }, { id: 3 })).json();
    const facts = called.result.structuredContent, grant = p.w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    assert.equal(facts.person, p.w.user.id);
    assert.equal(facts.agent, 'https://agent.example/client.json');
    assert.equal(facts.grant, grant.id);
    assert.deepEqual(facts.allowed, ['read']);
    assert.equal(facts.dpop_bound, false);
    assert.equal((await p.rpc(tokens.access_token, 'tools/call', { name: 'other' }, { id: 4 }).then(r => r.json())).error.code, -32602);
    assert.equal((await p.rpc(tokens.access_token, 'nope', {}, { id: 5 }).then(r => r.json())).error.code, -32601);
    assert.equal((await p.call(resource, { method: 'GET', headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 405);
    // The agent's metadata document names itself.
    const document = await (await p.call('https://app.example/agent/client.json')).json();
    assert.equal(document.client_id, 'https://app.example/agent/client.json');
    assert.ok(document.grant_types.includes('urn:ietf:params:oauth:grant-type:device_code'));
    // Logs record how each call authenticated, never the token.
    assert.ok(p.lines.length > 5);
    assert.ok(p.lines.every(line => !line.includes(tokens.access_token) && !line.includes(tokens.refresh_token)));
    assert.ok(p.lines.some(line => JSON.parse(line).client_id === 'https://agent.example/client.json'));
});

test('the probe refuses a token for another workspace, a forged token, a missing scope and a bare DPoP scheme', async t => {
    const p = await probeWorld(t), { tokens } = await p.w.grant();
    const other = await p.rpc(tokens.access_token, 'initialize', {}, { url: 'https://app.example/w/team-two/mcp' });
    assert.equal(other.status, 401);
    assert.match(other.headers.get('www-authenticate'), /team-two\/mcp", error="invalid_token"/);
    const [head, body, signature] = tokens.access_token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), scope: 'read write' })).toString('base64url');
    assert.equal((await p.rpc(`${head}.${forgedBody}.${signature}`, 'initialize')).status, 401);
    assert.equal((await p.rpc(tokens.access_token, 'initialize', {}, { scheme: 'DPoP' })).status, 401);
    assert.equal((await p.rpc('a b', 'initialize')).status, 401);
    assert.equal((await p.call('https://app.example/w/unknown/mcp', { method: 'POST' })).status, 404);
    const strict = await probeWorld(t, { SCOPE: 'write' });
    const { tokens: second } = await strict.w.grant();
    const refused = await strict.rpc(second.access_token, 'initialize');
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get('www-authenticate'), /error="insufficient_scope"/);
});

test('a revocation event reaches the probe once, and the still-unexpired token is refused after it', async t => {
    const p = await probeWorld(t), { tokens } = await p.w.grant();
    const grant = p.w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    p.w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    assert.equal((await p.rpc(tokens.access_token, 'ping')).status, 200);
    await p.w.form('/account/revoke', { grant_id: grant.id, csrf: p.w.csrf }, p.w.cookie);
    const delivered = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://app.example/backchannel');
        delivered.push(init.body);
        return p.call(url, init);
    });
    const message = { body: p.w.events[0], ack() {}, retry() { throw Error('delivery failed'); } };
    await queue({ messages: [message] }, p.w.env);
    assert.equal(delivered.length, 1);
    // Delivery is at least once: the same signed event arriving again is accepted and recorded once.
    const again = await p.call('https://app.example/backchannel', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: delivered[0] });
    assert.equal(again.status, 204);
    assert.equal(JSON.parse(p.lines.at(-1)).duplicate, true);
    const rows = p.DB.db.prepare('SELECT * FROM events').all();
    assert.equal(rows.length, 1, 'at-least-once delivery is recorded once');
    assert.equal(rows[0].kind, 'revocation'); assert.equal(rows[0].grant_id, grant.id); assert.equal(rows[0].resource, resource);
    const refused = await p.rpc(tokens.access_token, 'ping');
    assert.equal(refused.status, 401);
    assert.ok(p.lines.some(line => JSON.parse(line).reject === 'revoked'));
    assert.ok(p.lines.every(line => !line.includes(String(new URLSearchParams(String(delivered[0])).get('revocation_token')))));
});

test('the probe back-channel refuses forged, malformed and oversized events', async t => {
    const p = await probeWorld(t);
    const post = (body, type = 'application/x-www-form-urlencoded') => p.call('https://app.example/backchannel', { method: 'POST', headers: { 'content-type': type }, body });
    const unsigned = ['{"alg":"none","typ":"secevent+jwt"}', JSON.stringify({ iss: p.w.env.ISSUER, aud: 'app', sub: 'x', jti: 'j', grant_id: 'g', resource,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, events: { [`${p.w.env.ISSUER}/events/agent-revoked`]: {} } })]
        .map(x => Buffer.from(x).toString('base64url')).join('.') + '.';
    assert.equal((await post(new URLSearchParams({ revocation_token: unsigned }).toString())).status, 400);
    assert.equal((await post(new URLSearchParams({ revocation_token: 'x', logout_token: 'y' }).toString())).status, 400);
    assert.equal((await post('revocation_token=x', 'application/json')).status, 415);
    assert.equal((await post('revocation_token=' + 'a'.repeat(20000))).status, 413);
    assert.equal((await p.call('https://app.example/backchannel')).status, 405);
    assert.equal(p.DB.db.prepare('SELECT count(*) n FROM events').get().n, 0);
});

test('the probe refuses to start without its configuration', async t => {
    const p = await probeWorld(t, { WORKSPACES: '' });
    assert.equal((await p.call('https://app.example/')).status, 500);
    assert.equal(JSON.parse(p.lines.at(-1)).error, 'configuration');
});

test('the probe app client is valid seed SQL', () => {
    const sql = clientSeedSql(probeClient('https://probe.example.com', 'a'.repeat(64)));
    assert.match(sql, /^-- Review before applying/);
    assert.match(sql, /"https:\/\/probe\.example\.com\/w\/"/);
    assert.match(sql, /'on'/);
});
