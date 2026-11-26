// The MCP probe example (examples/mcp-probe) against the real Imprim Worker: challenge, metadata, a real agent
// token, and the trust boundaries it must hold (audience, scope, revocation, DPoP scheme, forged events, logs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentWorld, metadataId, resource } from './support/agents.mjs';
import { claims, deviceGrant, resource as productResource, setup as choiceWorld } from './support/agent-workspace-choice.mjs';
import { dpopKey } from './support/machine-keys.mjs';
import { choice, machineWorld } from './support/workspace-machines.mjs';
import { d1Database } from './support/sqlite.mjs';
import { cookieJar } from './support/world.mjs';
import probe from '../examples/mcp-probe/src/worker.mjs';
import { probeClient } from '../examples/mcp-probe/setup.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';
import { queue } from '../apps/server/src/services/maintenance.mjs';
import { signAgentJwt } from '../apps/server/src/agents/grants.mjs';

const metadataUrl = 'https://app.example/.well-known/oauth-protected-resource/w/team-one/mcp';
const productMetadata = 'https://app.example/.well-known/oauth-protected-resource/mcp';

async function probeWorld(t, settings = {}, world = agentWorld) {
    const w = await world(t);
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
    assert.equal(facts.kind, 'person');
    for (const absent of ['membership', 'workspace_id', 'accountable_sub']) assert.equal(Object.hasOwn(facts, absent), false);
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

test('the product resource and its metadata are off by default', async t => {
    const p = await probeWorld(t);
    assert.equal((await p.rpc(null, 'ping', {}, { url: productResource })).status, 404);
    assert.equal((await p.call(productMetadata)).status, 404);
    assert.equal((await p.call(productResource, { method: 'OPTIONS' })).status, 404);
});

test('the product resource requires a workspace choice and keeps both audiences separate', async t => {
    const p = await probeWorld(t, { PRODUCT_RESOURCE: 'on' }, choiceWorld);
    p.w.addWorkspace('chosen');
    const { access_token: token } = await p.w.grant('chosen');
    const atProduct = { url: productResource };
    const challenge = await p.rpc(null, 'ping', {}, atProduct);
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get('www-authenticate'), `Bearer resource_metadata="${productMetadata}"`);
    const metadata = await p.call(productMetadata);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { resource: productResource, authorization_servers: [p.w.env.ISSUER],
        scopes_supported: ['read'], bearer_methods_supported: ['header'] });

    const reply = await p.rpc(token, 'tools/call', { name: 'whoami' }, atProduct);
    assert.equal(reply.status, 200);
    const { result: { structuredContent: facts } } = await reply.json();
    assert.equal(facts.workspace_id, 'chosen');
    assert.equal(facts.workspace, 'chosen');
    assert.equal(facts.kind, 'person');
    assert.equal(facts.membership, 'not checked');

    const unscoped = claims(token);
    delete unscoped.workspace_id;
    const withoutWorkspace = await signAgentJwt(p.w.env, unscoped);
    const refused = await p.rpc(withoutWorkspace, 'ping', {}, atProduct);
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get('www-authenticate'), /error="invalid_token"/);
    assert.equal(JSON.parse(p.lines.at(-1)).reject, 'no_workspace');
    const malformed = await signAgentJwt(p.w.env, { ...unscoped, workspace_id: 1 });
    assert.equal((await p.rpc(malformed, 'ping', {}, atProduct)).status, 401);
    assert.equal((await p.rpc(token, 'ping')).status, 401);
    const ordinary = await p.w.grant(undefined, { options: { resource } });
    assert.equal((await p.rpc(ordinary.access_token, 'ping')).status, 200);
    assert.equal((await p.rpc(ordinary.access_token, 'ping', {}, atProduct)).status, 401);
});

test('an approved device grant can call whoami on the product resource', async t => {
    const p = await probeWorld(t, { PRODUCT_RESOURCE: 'on' }, choiceWorld);
    const { w } = p;
    w.addWorkspace('device-workspace');
    const started = await w.form('/device_authorization', { client_id: metadataId, resource: productResource, scope: 'read' });
    assert.equal(started.status, 200);
    const device = await started.json();
    const verify = new URL(device.verification_uri_complete);
    const browser = await w.call(verify.pathname + verify.search, { headers: { cookie: w.cookie } });
    assert.equal(browser.status, 303);
    const flow = { id: new URL(browser.headers.get('location')).searchParams.get('request_id'), cookie: `${w.cookie}; ${cookieJar(browser)}` };
    assert.equal((await w.approve(flow, 'device-workspace')).status, 200);
    w.db.exec('UPDATE agent_devices SET next_poll=0');
    const redeemed = await w.form('/token', { client_id: metadataId, resource: productResource, grant_type: deviceGrant, device_code: device.device_code });
    assert.equal(redeemed.status, 200);
    const token = (await redeemed.json()).access_token;
    const reply = await p.rpc(token, 'tools/call', { name: 'whoami' }, { url: productResource });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).result.structuredContent.workspace_id, 'device-workspace');
});

test('the product resource checks membership on every request when configured', async t => {
    const p = await probeWorld(t, { PRODUCT_RESOURCE: 'on', APP_SECRET: 'secret' }, choiceWorld);
    p.w.addWorkspace('chosen');
    const { access_token: token } = await p.w.grant('chosen');
    const whoami = () => p.rpc(token, 'tools/call', { name: 'whoami' }, { url: productResource });
    const member = await whoami();
    assert.equal(member.status, 200);
    assert.equal((await member.json()).result.structuredContent.membership, 'checked');
    p.w.addWorkspace('other-workspace');
    await p.w.mutation('DELETE', 'chosen', `members/${encodeURIComponent(p.w.user.id)}`);
    // The product still denies the member before any revocation event arrives, even when they belong to another workspace.
    const removed = await whoami();
    assert.equal(removed.status, 403);
    assert.match(removed.headers.get('www-authenticate'), /error="insufficient_scope"/);
    assert.equal(JSON.parse(p.lines.at(-1)).reject, 'not_member');

    p.env.APP_SECRET = 'invalid-app-credential';
    assert.equal((await whoami()).status, 500);
});

test('the product resource refuses replayed DPoP proofs and delivered revocations', async t => {
    const p = await probeWorld(t, { PRODUCT_RESOURCE: 'on' }, choiceWorld);
    const { w } = p;
    w.db.prepare("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'").run();
    w.addWorkspace('chosen');
    const { access_token: bearer } = await w.grant('chosen');
    const key = await dpopKey();
    const grant = claims(bearer).grant_id;
    const token = await signAgentJwt(w.env, { ...claims(bearer), cnf: { jkt: key.jkt } });
    const proof = () => key.proof({ htu: productResource, accessToken: token });
    const ping = dpop => p.rpc(token, 'ping', {}, { url: productResource, scheme: 'DPoP', headers: { dpop } });
    const original = await proof();
    assert.equal((await ping(original)).status, 200);
    assert.equal((await ping(original)).status, 401);
    assert.equal(JSON.parse(p.lines.at(-1)).reject, 'dpop_replay');
    assert.equal((await w.form('/account/revoke', { grant_id: grant, csrf: w.csrf }, w.cookie)).status, 303);
    t.mock.method(globalThis, 'fetch', (url, init) => p.call(url, init));
    await queue({ messages: [{ body: w.events[0], ack() {}, retry() { throw Error('delivery failed'); } }] }, w.env);
    assert.equal(p.DB.db.prepare('SELECT resource FROM events WHERE grant_id=?').get(grant)?.resource, productResource);
    assert.equal((await ping(await proof())).status, 401);
    assert.equal(JSON.parse(p.lines.at(-1)).reject, 'revoked');
});

test('an approved workspace machine token identifies its accountable member at the product resource', async t => {
    const p = await probeWorld(t, { PRODUCT_RESOURCE: 'on', APP_SECRET: 'secret' }, machineWorld);
    const clientId = await p.w.approve();
    const issued = await p.w.token(clientId, choice);
    assert.equal(issued.status, 200);
    const { access_token: token } = await issued.json();
    const whoami = () => p.rpc(token, 'tools/call', { name: 'whoami' }, { url: choice });
    const reply = await whoami();
    assert.equal(reply.status, 200);
    const { result: { structuredContent: facts } } = await reply.json();
    assert.equal(facts.person, `service:${clientId}`);
    assert.equal(facts.kind, 'machine');
    assert.equal(facts.workspace_id, 'ws_test');
    assert.equal(facts.accountable_sub, p.w.owner.user.id);
    assert.equal(facts.membership, 'checked');
    p.w.db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run('ws_test', p.w.owner.user.id);
    assert.equal((await whoami()).status, 403);
    assert.equal(JSON.parse(p.lines.at(-1)).reject, 'not_member');
});

test('setup --product emits runnable shared-workspace SQL and keeps the test secret out of output', t => {
    const dir = mkdtempSync(join(tmpdir(), 'imprim-probe-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'app-secret');
    const setup = (...args) => spawnSync(process.execPath, ['examples/mcp-probe/setup.mjs', '--secret-out', path, ...args], { encoding: 'utf8' });
    for (const invalid of ['a', 'A-probe', '1probe', 'a'.repeat(41)]) {
        const result = setup('--product', invalid);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.equal(existsSync(path), false);
    }
    const result = setup('--product', 'probe-tools');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /PRODUCT_RESOURCE=on/);
    assert.match(result.stderr, /wrangler secret put APP_SECRET/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const generated = readFileSync(path, 'utf8').trim();
    assert.ok(generated && !result.stdout.includes(generated) && !result.stderr.includes(generated));
    const { db } = d1Database();
    t.after(() => db.close());
    db.exec(result.stdout);
    const row = db.prepare("SELECT workspaces,product,agent_workspace_resources,agent_resource_prefixes FROM clients WHERE id='probe'").get();
    assert.equal(row.workspaces, 'shared');
    assert.equal(row.product, 'probe-tools');
    assert.deepEqual(JSON.parse(row.agent_workspace_resources), ['https://probe.example.com/mcp']);
    assert.deepEqual(JSON.parse(row.agent_resource_prefixes), ['https://probe.example.com/w/', 'https://probe.example.com/mcp']);
});
