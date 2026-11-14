import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDeliveries, deliveryStatus } from '../apps/server/src/services/outbox.mjs';
import { agentWorld, metadataId, redirectUri, resource, metadata, error } from './support/agents.mjs';
import { cookieJar } from './support/world.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';

for (const [name, change, expected] of [
    ['missing PKCE', { code_challenge: null }, 'invalid_request'],
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['missing resource', { resource: null }, 'invalid_target'],
    ['missing state', { state: null }, 'invalid_request'],
    ['redirect mismatch', { redirect_uri: 'http://127.0.0.1:4567/evil' }, 'invalid_request'],
    ['redirect query mismatch', { redirect_uri: redirectUri + '?evil=1' }, 'invalid_request'],
    ['HTTPS port mismatch', { redirect_uri: 'https://agent.example:444/callback' }, 'invalid_request'],
    ['unregistered resource', { resource: 'https://evil.example/w/team-one/mcp' }, 'invalid_target'],
    ['prefix confusion', { resource: 'https://app.example/workspace/mcp' }, 'invalid_target'],
    ['encoded path', { resource: 'https://app.example/w/a%2fb/mcp' }, 'invalid_target'],
    ['resource with query', { resource: resource + '?tenant=two' }, 'invalid_target'],
    ['unknown scope', { scope: 'admin' }, 'invalid_scope'],
    ['empty scope', { scope: '' }, 'invalid_scope'],
    ['duplicate scope', { scope: 'read read' }, 'invalid_scope'],
    ['silent consent', { prompt: 'none' }, 'consent_required']
]) test(`agent refuses ${name}`, async t => {
    const w = await agentWorld(t); await error((await w.start(change)).response, expected);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 0);
});

for (const uri of ['http://127.0.0.1:9999/callback', 'http://[::1]:8888/callback', 'http://localhost:7777/callback', 'https://agent.example/callback'])
    test(`agent allows registered redirect ${uri}`, async t => {
        const w = await agentWorld(t); assert.equal((await w.start({ redirect_uri: uri })).response.status, 303);
    });

test('duplicate resources are refused at authorize, token, and device endpoints', async t => {
    const w = await agentWorld(t);
    await error(await w.call('/authorize?' + new URLSearchParams(await w.query()) + '&resource=' + encodeURIComponent(resource)), 'invalid_request');
    for (const path of ['/token','/device_authorization']) await error(await w.call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'resource=a&resource=b' }), 'invalid_request');
});

test('wrong workspace, client, PKCE and exact exchanged redirect cannot consume a valid code', async t => {
    const w = await agentWorld(t), flow = await w.start(), approved = await w.approve(flow);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    for (const change of [{ resource: 'https://app.example/w/team-two/mcp' }, { client_id: 'https://other.example/client' }, { code_verifier: 'z'.repeat(43) }, { redirect_uri: 'http://127.0.0.1:9876/callback' }])
        await error(await w.exchange(code, change), 'invalid_grant');
    const tokens = await (await w.exchange(code)).json(); assert.ok(tokens.access_token);
    await error(await w.refresh(tokens.refresh_token, { resource: 'https://app.example/w/team-two/mcp' }), 'invalid_grant');
    await error(await w.refresh(tokens.refresh_token, { scope: 'write' }), 'invalid_scope');
    assert.equal((await w.refresh(tokens.refresh_token)).status, 200);
});

for (const [name, sql] of [
    ['agent_access off', "agent_access='off'"],
    ['allowlist miss', `agent_allowlist='["other.example"]'`],
    ['registration method removed', `agent_registration_methods='["dynamic"]'`],
    ['scope removed', `agent_scope_catalogue='{"write":"Edit"}'`],
    ['resource prefix removed', `agent_resource_prefixes='["https://different.example/w/"]'`],
    ['sign-in method disabled', `sign_in_methods='["google"]'`]
]) test(`current app policy (${name}) is enforced at consent, code exchange, and refresh`, async t => {
    const w = await agentWorld(t);
    const active = await w.grant(), pending = await w.start(), exchangeFlow = await w.start();
    const approved = await w.approve(exchangeFlow), code = new URL(approved.headers.get('location')).searchParams.get('code');
    w.env.DB.db.exec(`UPDATE clients SET ${sql} WHERE id='app'`);
    for (const response of [await w.approve(pending), await w.exchange(code), await w.refresh(active.tokens.refresh_token)]) assert.ok(response.status >= 400, await response.text());
    if (name !== 'sign-in method disabled') assert.ok((await w.start()).response.status >= 400);
    else assert.equal((await w.start()).response.status, 200); // interactive sign-in offers the new allowed method
});

test('default off, allowlist URL/host, overlapping owners and grant lifetime cap', async t => {
    const w = await agentWorld(t);
    assert.equal(w.env.DB.db.prepare("SELECT agent_access FROM clients WHERE id='other'").get().agent_access, 'off');
    for (const entry of ['agent.example', metadataId]) {
        w.env.DB.db.prepare("UPDATE clients SET agent_allowlist=? WHERE id='app'").run(JSON.stringify([entry]));
        assert.equal((await w.start()).response.status, 303);
    }
    w.env.DB.db.exec("UPDATE clients SET agent_max_grant_days=1 WHERE id='app'");
    const issued = await w.grant(), grant = w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    assert.equal(grant.expires_at - grant.created, 86400000);
    w.env.DB.db.prepare('UPDATE agent_grants SET created=?,expires_at=?').run(Date.now() - 2 * 86400000, Date.now() + 86400000);
    await error(await w.refresh(issued.tokens.refresh_token), 'invalid_grant');
    w.env.DB.db.exec(`UPDATE clients SET agent_resource_prefixes='["https://app.example/w/"]' WHERE id='other'`);
    await error((await w.start()).response, 'invalid_target');
});

test('consent requires current session, browser binding, Origin and CSRF; denial is single use', async t => {
    const w = await agentWorld(t), flow = await w.start();
    await error(await w.call('/agent/consent?request_id=' + flow.id), 'login_required');
    await error(await w.form('/agent/consent', { request_id: flow.id, csrf: w.csrf, decision: 'approve' }, w.cookie), 'browser_binding');
    await error(await w.form('/agent/consent', { request_id: flow.id, csrf: w.csrf, decision: 'approve' }, flow.cookie, { origin: 'https://evil.example' }), 'origin');
    await error(await w.form('/agent/consent', { request_id: flow.id, csrf: 'wrong', decision: 'approve' }, flow.cookie), 'csrf');
    const denied = await w.approve(flow, 'deny');
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
    assert.ok((await w.approve(flow)).status >= 400);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 0);
});

test('concurrent consent and code exchange are single-use', async t => {
    const w = await agentWorld(t), flow = await w.start();
    const consent = await Promise.all([w.approve(flow), w.approve(flow)]);
    assert.equal(consent.filter(r => r.status === 303).length, 1);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 1);
    const code = new URL(consent.find(r => r.status === 303).headers.get('location')).searchParams.get('code');
    const tokens = await Promise.all([w.exchange(code), w.exchange(code)]);
    assert.deepEqual(tokens.map(r => r.status).sort(), [200,400]);
});

test('connected grants are person-scoped and revocation is CSRF protected', async t => {
    const w = await agentWorld(t); await w.grant();
    const grant = w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    const other = await issueSession(w.env, await ensureUser(w.env, 'other@example.com'), 'email');
    const cookie = other.cookies.map(c => c.split(';')[0]).join('; '), csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    assert.doesNotMatch(await (await w.call('/account', { headers: { cookie } })).text(), /Example Agent/);
    await error(await w.form('/account/revoke', { grant_id: grant.id, csrf }, cookie), 'access_denied');
    await error(await w.form('/account/revoke', { grant_id: grant.id, csrf: 'bad' }, w.cookie), 'csrf');
    await error(await w.form('/account/revoke', { grant_id: grant.id, csrf: w.csrf }, w.cookie, { origin: 'https://evil.example' }), 'origin');
    assert.equal(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at, null);
});

test('revocation commits during a queue outage; the person never sees a 500, and cron queues the durable event (S13)', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant(), grant = w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    const send = w.env.LOGOUT_QUEUE.send; w.env.LOGOUT_QUEUE = { async send() { throw new Error('queue unavailable'); } };
    t.mock.method(console, 'error', () => {});
    assert.equal((await w.form('/account/revoke', { grant_id: grant.id, csrf: w.csrf }, w.cookie)).status, 303);
    await w.drain();
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.equal(w.env.DB.db.prepare('SELECT queued_at FROM agent_revocation_outbox').get().queued_at, null);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
    w.env.LOGOUT_QUEUE = { send };
    await dispatchDeliveries(w.env);
    assert.equal(w.events.length, 1);
    assert.ok(w.env.DB.db.prepare('SELECT queued_at FROM agent_revocation_outbox').get().queued_at);
});
test('a revocation for an app without a back-channel URI is kept and reported as missing_uri (S17)', async t => {
    const w = await agentWorld(t); await w.grant();
    const grant = w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    assert.equal((await w.form('/account/revoke', { grant_id: grant.id, csrf: w.csrf }, w.cookie)).status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_revocation_outbox').get().n, 1);
    assert.deepEqual((await deliveryStatus(w.env)).clients_missing_backchannel, ['app']);
});

test('agent uses app sign-in and resumes consent after magic verification, including browser_response', async t => {
    const w = await agentWorld(t), flow = await w.start({}, '');
    assert.equal(flow.response.status, 200);
    const id = (await flow.response.text()).match(/data-request-id="([^"]+)"/)[1];
    assert.equal((await w.post('/v1/auth/magic/request', { request_id: id, email: w.user.email, turnstile: crypto.randomUUID() }, flow.cookie)).status, 200);
    await w.drain(); const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const signed = await w.post('/v1/auth/magic/verify', { token, browser_response: true }, flow.cookie);
    const result = await signed.json(); assert.equal(result.redirect, `${w.env.ISSUER}/agent/consent?request_id=${id}`);
    const cookie = flow.cookie + '; ' + cookieJar(signed);
    const consent = await w.call('/agent/consent?request_id=' + id, { headers: { cookie } }); assert.equal(consent.status, 200);
});

test('agent requests preserve app admission and direct sign-in method enforcement', async t => {
    const w = await agentWorld(t);
    w.env.DB.db.exec("UPDATE clients SET signup_policy='invited' WHERE id='app'");
    const flow = await w.start({}, ''), id = (await flow.response.text()).match(/data-request-id="([^"]+)"/)[1];
    await w.post('/v1/auth/magic/request', { request_id: id, email: 'new@example.com', turnstile: crypto.randomUUID() }, flow.cookie);
    await w.drain(); assert.equal(w.mails.length, 0);
    w.env.DB.db.exec(`UPDATE clients SET sign_in_methods='["google"]' WHERE id='app'`);
    await error(await w.post('/v1/auth/magic/request', { request_id: id, email: w.user.email, turnstile: crypto.randomUUID() }, flow.cookie), 'access_denied');
});

test('blocked/deleted/merged people cannot exchange or refresh agent grants', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    const flow = await w.start(), approved = await w.approve(flow), code = new URL(approved.headers.get('location')).searchParams.get('code');
    for (const status of ['blocked','deleted']) {
        w.env.DB.db.prepare('UPDATE users SET status=? WHERE id=?').run(status, w.user.id);
        await error(await w.refresh(tokens.refresh_token), 'invalid_grant'); await error(await w.exchange(code), 'invalid_grant');
    }
});

test('offline seed validates and serializes agent settings', async t => {
    const w = await agentWorld(t), base = { id: 'seeded', secret_hash: null, redirect_uris: ['https://example.com/callback'], sign_in_methods: ['email'] };
    w.env.DB.db.exec(clientSeedSql(base));
    const row = w.env.DB.db.prepare("SELECT * FROM clients WHERE id='seeded'").get();
    assert.equal(row.agent_access, 'off'); assert.equal(row.agent_max_grant_days, 90);
    for (const change of [{ agent_access: 'yes' }, { agent_access: 'on' }, { agent_registration_methods: [] }, { agent_allowlist: ['*.example.com'] },
        { agent_scope_catalogue: { 'bad scope': 'Bad' } }, { agent_resource_prefixes: ['http://example.com/'] }, { agent_max_grant_days: 0 }, { agent_max_grant_days: 1.5 }])
        assert.throws(() => clientSeedSql({ ...base, ...change }), JSON.stringify(change));
});

test('loopback matching varies only the port, never normalized path or query', async t => {
    const w = await agentWorld(t);
    for (const uri of ['http://127.0.0.1:4567/path/../callback', 'http://127.0.0.1:4567/%63allback', 'http://127.0.0.1:4567/callback?'])
        await error((await w.start({ redirect_uri: uri })).response, 'invalid_request');
    assert.equal((await w.start({ redirect_uri: 'http://127.0.0.1:80/callback' })).response.status, 303);
});
