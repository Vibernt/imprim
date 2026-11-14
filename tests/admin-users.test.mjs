import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, resource } from './support/agents.mjs';
import { adminLogin } from './support/admin.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { login, world, turnstile } from './support/world.mjs';
import { queue, scheduled } from '../apps/server/src/services/maintenance.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';

for (const action of ['block','delete']) test(`${action} atomically ends all identity sessions, app sessions and grants; fake receiver deduplicates`, async t => {
    const w = await agentWorld(t), a = await adminLogin(w);
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel'");
    const { tokens } = await w.grant();
    // Issue two human app sessions, and associate a second app with one of them.
    const human = await w.authorize({}, w.cookie);
    assert.equal((await w.call('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + btoa('app:secret') },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(human.headers.get('location')).searchParams.get('code'), redirect_uri: 'https://app.example/callback', code_verifier: w.verifier }) })).status, 200);
    const other = await w.authorize({ client_id: 'other' }, w.cookie);
    assert.equal((await w.call('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + btoa('other:secret') },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(other.headers.get('location')).searchParams.get('code'), redirect_uri: 'https://app.example/callback', code_verifier: w.verifier }) })).status, 200);
    const second = await issueSession(w.env, w.user, 'email');
    // Historical association persists after identity expiry/cleanup.
    w.env.DB.db.prepare('INSERT INTO app_sessions VALUES(?,?,?,?)').run('app', w.user.id, second.session.sid, Date.now());
    w.env.DB.db.prepare('DELETE FROM sessions WHERE hash=?').run(second.session.hash);
    const response = await a.post(`users/${w.user.id}/${action}`); assert.equal(response.status, 200, await response.text()); await w.drain();
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(w.user.id).n, 0);
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.equal((await w.refresh(tokens.refresh_token)).status, 400);
    assert.equal(w.events.filter(x => x.type === 'human_logout').length, 2);
    assert.equal(w.events.filter(x => x.type === 'agent_revocation').length, 1);
    const clients = Object.fromEntries(['app','other'].map(clientId => [clientId, createClient({ issuer: w.env.ISSUER, clientId, redirectUri: 'https://app.example/callback', fetch: url => w.call(new URL(url).pathname) })]));
    w.env.DB.db.exec('CREATE TABLE fake_app_logout_events(jti TEXT PRIMARY KEY)');
    const ended = [], notifications = [];
    t.mock.method(globalThis, 'fetch', async (uri, init) => {
        assert.equal(uri, 'https://app.example/backchannel'); assert.equal(init.redirect, 'manual');
        const body = new URLSearchParams(init.body);
        if (body.has('revocation_token')) { notifications.push(await clients.app.handleAgentRevocation(new Request(uri, { method: 'POST', body }))); return new Response(null, { status: 204 }); }
        const raw = body.get('logout_token'), untrusted = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url'));
        const claims = await clients[untrusted.aud].handleBackchannelLogout(new Request(uri, { method: 'POST', body }));
        const consumed = w.env.DB.db.prepare('INSERT OR IGNORE INTO fake_app_logout_events VALUES(?)').run(claims.jti);
        if (consumed.changes) ended.push(claims);
        return new Response(null, { status: 204 });
    });
    let acks = 0, retries = 0;
    // User lifecycle events are covered in user-events.test.mjs; this test is about logout and revocation.
    const batch = { messages: w.events.filter(body => body.type !== 'user_event').map(body => ({ body, ack() { acks++; }, retry() { retries++; } })) };
    await queue(batch, w.env); await queue(batch, w.env);
    assert.equal(acks, 6); assert.equal(retries, 0); assert.equal(ended.length, 2); assert.equal(notifications.length, 1);
    assert.ok(ended.every(c => c.sub === w.user.id));
    assert.equal(ended.filter(c => c.sid).length, 1); // Multi-session app receives subject-wide logout.
    // Simulate lost ack after remote success. Same durable jti remains a no-op at the RP.
    w.env.DB.db.exec('UPDATE logout_outbox SET delivered_at=NULL');
    await queue(batch, w.env); assert.equal(ended.length, 2);
    if (action === 'block') {
        assert.equal((await a.post(`users/${w.user.id}/unblock`)).status, 200);
        assert.equal((await w.refresh(tokens.refresh_token)).status, 400);
        assert.ok((await issueSession(w.env, { ...w.user, status: 'active' }, 'email')).session);
    } else assert.equal((await a.post(`users/${w.user.id}/unblock`)).status, 400);
    const event = w.env.DB.db.prepare('SELECT * FROM audit WHERE event=?').get('admin_' + action);
    assert.equal(event.target, w.user.id); assert.ok(event.actor);
    const client = clients.app;
    // Exact expiry with no positive leeway: already-issued agent tokens stop at 60 seconds.
    const claims = await client.verifyAccessToken(tokens.access_token, { audience: resource });
    assert.equal(claims.exp - claims.iat, 60);
    t.mock.method(Date, 'now', () => claims.exp * 1000);
    await assert.rejects(client.verifyAccessToken(tokens.access_token, { audience: resource }), /Invalid access-token/);
});

test('failed queue and receiver keep durable outbox, scheduled dispatcher retries, no silent success', async t => {
    const w = await agentWorld(t), a = await adminLogin(w);
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel'");
    await w.grant();
    w.env.DB.db.prepare('INSERT INTO app_sessions VALUES(?,?,?,?)').run('app', w.user.id, w.signed.session.sid, Date.now());
    w.env.LOGOUT_QUEUE.send = async () => { throw Error('offline'); };
    assert.equal((await a.post(`users/${w.user.id}/block`)).status, 200); await w.drain();
    for (const table of ['logout_outbox','agent_revocation_outbox']) assert.equal(w.env.DB.db.prepare(`SELECT queued_at FROM ${table}`).get().queued_at, null);
    assert.ok(w.env.DB.db.prepare("SELECT 1 FROM audit WHERE event='admin_dispatch_failed'").get());
    w.env.LOGOUT_QUEUE.send = async event => w.events.push(event);
    await scheduled(w.env); assert.equal(w.events.filter(e => e.type !== 'user_event').length, 2);
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
    let retries = 0;
    await queue({ messages: w.events.filter(body => body.type !== 'user_event').map(body => ({ body, ack() { assert.fail('failed receiver was acked'); }, retry({ delaySeconds }) { assert.equal(delaySeconds, 10); retries++; } })) }, w.env);
    assert.equal(retries, 2);
    for (const table of ['logout_outbox','agent_revocation_outbox']) {
        assert.equal(w.env.DB.db.prepare(`SELECT delivered_at FROM ${table}`).get().delivered_at, null);
        w.env.DB.db.exec(`UPDATE ${table} SET queued_at=0`);
    }
    await scheduled(w.env); assert.equal(w.events.filter(e => e.type !== 'user_event').length, 4);
});

test('block transaction rolls back status, outbox, sessions and revocations if audit fails', async t => {
    const w = await agentWorld(t), a = await adminLogin(w); await w.grant();
    w.env.DB.db.exec("CREATE TRIGGER fail_admin_audit BEFORE INSERT ON audit WHEN NEW.event='admin_block' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
    assert.equal((await a.post(`users/${w.user.id}/block`)).status, 500);
    assert.equal(w.env.DB.db.prepare('SELECT status FROM users WHERE id=?').get(w.user.id).status, 'active');
    assert.equal(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at, null);
    assert.ok(w.env.DB.db.prepare('SELECT 1 FROM sessions WHERE user_id=?').get(w.user.id));
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM logout_outbox').get().n, 0);
});

test('merge moves identities and preserves survivor id, terminates both accounts access, and audits', async t => {
    const w = await agentWorld(t), a = await adminLogin(w); await w.grant();
    const survivor = await ensureUser(w.env, 'survivor@example.com'); await issueSession(w.env, survivor, 'email');
    w.env.DB.db.prepare('INSERT INTO app_sessions VALUES(?,?,?,?)').run('app', w.user.id, w.signed.session.sid, Date.now());
    w.env.DB.db.prepare('INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES(?,?,?,?,?)').run('github','123',w.user.id,'source',Date.now());
    w.env.DB.db.prepare('INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES(?,?,?,?,?)').run('google','456',survivor.id,null,Date.now());
    const response = await a.post(`users/${w.user.id}/merge`, { surviving_id: survivor.id, confirm_source_email: w.user.email }); assert.equal(response.status, 200, await response.text());
    assert.equal(w.env.DB.db.prepare("SELECT user_id FROM user_identities WHERE provider='github'").get().user_id, survivor.id);
    assert.equal(w.env.DB.db.prepare('SELECT merged_into FROM users WHERE id=?').get(w.user.id).merged_into, survivor.id);
    assert.equal(w.env.DB.db.prepare('SELECT user_id FROM logout_outbox').get().user_id, w.user.id);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions WHERE user_id IN (?,?)').get(w.user.id, survivor.id).n, 0);
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.equal(JSON.parse(w.env.DB.db.prepare("SELECT detail FROM audit WHERE event='admin_merge'").get().detail).surviving_id, survivor.id);
});
for (const reason of ['same provider','same user','missing survivor','blocked survivor','self action','deleted source']) test(`merge/status refuses ${reason}`, async t => {
    const w = await agentWorld(t), a = await adminLogin(w), survivor = await ensureUser(w.env, 'survivor@example.com');
    let source = w.user.id, target = survivor.id;
    if (reason === 'same provider') for (const [n,id] of [w.user.id,survivor.id].entries()) w.env.DB.db.prepare('INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES(?,?,?,?,?)').run('github', String(n), id, null, Date.now());
    if (reason === 'same user') target = source;
    if (reason === 'missing survivor') target = 'missing';
    if (reason === 'blocked survivor') w.env.DB.db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(target);
    if (reason === 'self action') source = w.env.DB.db.prepare("SELECT id FROM users WHERE email='admin@example.com'").get().id;
    if (reason === 'deleted source') w.env.DB.db.prepare("UPDATE users SET status='deleted' WHERE id=?").run(source);
    const response = await a.post(`users/${source}/merge`, { surviving_id: target, confirm_source_email: w.env.DB.db.prepare('SELECT email FROM users WHERE id=?').get(source).email }); assert.ok([400,409].includes(response.status), await response.text());
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_merge'").get().n, 0);
});

test('human logout emits durable logout even when app access token already expired', async t => {
    const w = await world(t); const signed = await login(w, t); await w.exchange(signed.code);
    w.env.DB.db.exec('DELETE FROM access_tokens');
    w.env.LOGOUT_QUEUE = { async send() {} };
    const csrf = signed.cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const response = await w.call('/logout', { method: 'POST', headers: { cookie: signed.cookie, origin: w.env.ISSUER, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'app', csrf }) });
    assert.equal(response.status, 303); await w.drain();
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM logout_outbox').get().n, 1);
});

test('dispatcher drains more than one page, missing back-channel configuration is visible and never acknowledged', async t => {
    const w = await agentWorld(t), a = await adminLogin(w);
    for (let n=0; n<105; n++) w.env.DB.db.prepare('INSERT INTO logout_outbox(id,client_id,user_id,created) VALUES(?,?,?,?)').run('event-' + n, 'app', w.user.id, Date.now());
    await a.post(`users/${w.user.id}/block`); await w.drain(); assert.equal(w.events.length, 105);
    const settings = await (await a.get('settings')).json(); assert.deepEqual(settings.delivery.clients_missing_backchannel, ['app']);
    assert.equal(settings.delivery.human.pending, 105);
    let retries = 0;
    await queue({ messages: [{ body: w.events[0], ack() { assert.fail('unconfigured destination'); }, retry() { retries++; } }] }, w.env);
    assert.equal(retries, 1);
});
