import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/server/src/worker.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { signIdToken } from '../apps/server/src/oidc/jwt.mjs';
import { jwksDocument } from '../apps/server/src/oidc/keys.mjs';
import { from64 } from '../apps/server/src/lib/crypto.mjs';
import { deliveryStatus, dispatchDeliveries } from '../apps/server/src/services/outbox.mjs';
import { deliveryWindowMs } from '../apps/server/src/services/outbox-expiry.mjs';
import { cleanDeliveryHistory } from '../apps/server/src/services/retention.mjs';
import { world, basic } from './support/world.mjs';

async function setup(t) {
    const w = await world(t);
    const db = w.env.DB.db, queued = [];
    w.env.LOGOUT_QUEUE = { async send(message) { queued.push(message); } };
    db.prepare("UPDATE realms SET config=json_set(config,'$.workspaces','on')").run();
    db.prepare("UPDATE clients SET workspaces='shared',product='notes',workspace_admin='on',backchannel_uri=? WHERE id='app'")
        .run('https://app.example/old');
    const user = await ensureUser(w.env, 'owner@example.com');
    const { session } = await issueSession(w.env, user, 'email');
    const actor_token = await signIdToken(w.env, session, { client_id: 'app', scope: 'openid' });
    const write = async (method, path, fields, status = 200) => {
        const response = await w.call(path, {
            method, headers: { authorization: basic(), 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, actor_token })
        });
        const data = await response.json();
        assert.equal(response.status, status, JSON.stringify(data));
        return data;
    };
    const { workspace_id } = await write('POST', '/v1/workspaces', {
        name: 'Launch', products: ['notes'], first_owner_email: user.email
    }, 201);
    const path = '/v1/workspaces/' + workspace_id;
    await write('PATCH', path, { name: 'Launchpad' });
    return { ...w, db, user, workspace_id, queued, write, path, rows: () => db.prepare('SELECT * FROM workspace_event_outbox ORDER BY version').all() };
}

async function consume(env, body) {
    const outcome = { ack: false, retry: null };
    await worker.queue({ messages: [{ body, ack() { outcome.ack = true; }, retry(options) { outcome.retry = options; } }] }, env);
    return outcome;
}
const acknowledged = { ack: true, retry: null }, retried = { ack: false, retry: { delaySeconds: 10 } };

async function verifiedPayload(env, token) {
    const [head, body, sig] = token.split('.');
    const parse = part => JSON.parse(new TextDecoder().decode(from64(part)));
    const header = parse(head);
    assert.equal(header.typ, 'secevent+jwt');
    assert.equal(header.alg, 'ES256');
    const { keys } = await jwksDocument(env);
    const key = await crypto.subtle.importKey('jwk', keys.find(k => k.kid === header.kid), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, from64(sig), new TextEncoder().encode(head + '.' + body)));
    return parse(body);
}

test('workspace events dispatch from cron, use the current URI, are signed, and acknowledge duplicate delivery', async t => {
    const w = await setup(t), posts = [];
    t.mock.method(globalThis, 'fetch', async (uri, init) => {
        assert.equal(uri, 'https://app.example/current');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'manual');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.deepEqual([...init.body.keys()], ['workspace_token']);
        posts.push(await verifiedPayload(w.env, init.body.get('workspace_token')));
        return new Response(null, { status: 204 });
    });
    w.db.prepare("UPDATE clients SET backchannel_uri='https://app.example/current' WHERE id='app'").run();
    const pending = w.rows();
    assert.ok(pending.every(r => r.uri === 'https://app.example/old' && r.queued_at === null));
    assert.deepEqual((await deliveryStatus(w.env)).workspace_events, { pending: 2, oldest: pending[0].created });

    await worker.scheduled({}, w.env);
    assert.equal(w.queued.length, 2);
    assert.ok(w.rows().every(row => row.queued_at > 0));
    await dispatchDeliveries(w.env);
    assert.equal(w.queued.length, 2, 'recently queued rows are not dispatched again');
    const before = Math.floor(Date.now() / 1000);
    for (const row of pending) {
        const message = w.queued.find(entry => entry.event_id === row.id);
        assert.equal(message.type, 'workspace_event');
        assert.deepEqual(await consume(w.env, message), acknowledged);
        assert.deepEqual(await consume(w.env, message), acknowledged);
    }
    assert.equal(posts.length, 2);
    for (const [index, claim] of posts.entries()) {
        const row = pending[index];
        assert.equal(claim.iss, w.env.ISSUER);
        assert.equal(claim.aud, 'app');
        assert.equal(claim.jti, row.id);
        assert.ok(claim.iat >= before && claim.iat <= Math.floor(Date.now() / 1000));
        assert.equal(claim.exp, claim.iat + 300);
        assert.equal(claim.toe, Math.floor(row.created / 1000));
        assert.equal(Object.hasOwn(claim, 'sub'), index === 0);
        if (index === 0) assert.equal(claim.sub, w.user.id);
        assert.deepEqual(claim.events, { [w.env.ISSUER + '/events/' + row.event]: JSON.parse(row.payload) });
    }
    assert.deepEqual(posts[0].events[w.env.ISSUER + '/events/workspace-member-added'], { workspace_id: w.workspace_id, version: 1, role: 'owner' });
    assert.deepEqual(posts[1].events[w.env.ISSUER + '/events/workspace-updated'], { workspace_id: w.workspace_id, version: 2, name: 'Launchpad' });
    assert.ok(w.rows().every(row => row.delivered_at > 0 && row.delivery_state === 'delivered'));
    assert.deepEqual((await deliveryStatus(w.env)).workspace_events, { pending: 0, oldest: null });
});

test('a missing endpoint or refused POST is retried, retains its jti, and is requeued after a minute', async t => {
    const w = await setup(t), polls = [];
    let status = 302;
    t.mock.method(globalThis, 'fetch', async (uri, init) => {
        assert.equal(uri, 'https://app.example/recovered');
        polls.push(await verifiedPayload(w.env, init.body.get('workspace_token')));
        return new Response(null, { status, headers: { location: 'https://refuse-redirect.example/' } });
    });
    await dispatchDeliveries(w.env);
    const row = w.rows()[0], message = w.queued.find(entry => entry.event_id === row.id);
    w.db.prepare("UPDATE clients SET backchannel_uri=NULL WHERE id='app'").run();
    assert.deepEqual(await consume(w.env, message), retried);
    assert.equal(polls.length, 0);
    assert.equal(w.rows()[0].delivery_state, 'missing_uri');
    assert.match(w.rows()[0].last_error, /current back-channel URI/);
    w.db.prepare("UPDATE clients SET backchannel_uri='https://app.example/recovered' WHERE id='app'").run();
    assert.deepEqual(await consume(w.env, message), retried);
    assert.equal(w.rows()[0].delivery_state, 'pending');
    assert.match(w.rows()[0].last_error, /HTTP 302/);
    w.db.prepare('UPDATE workspace_event_outbox SET queued_at=0 WHERE id=?').run(row.id);
    await dispatchDeliveries(w.env);
    assert.equal(w.queued.length, 3);
    assert.deepEqual(w.queued.at(-1), message);
    status = 200;
    assert.deepEqual(await consume(w.env, message), acknowledged);
    assert.deepEqual(polls.map(claim => claim.jti), [row.id, row.id]);
    assert.equal(w.rows()[0].delivery_state, 'delivered');
});

test('cron and the consumer expire workspace events before delivery and retention keeps pending events', async t => {
    const w = await setup(t);
    await w.write('PATCH', w.path, { name: 'Newer' });
    await w.write('PATCH', w.path, { name: 'Newest' });
    const [cron, consumer, delivered, pending] = w.rows(), now = Date.now(), ancient = now - 32 * 86400000;
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected network request'); });
    const state = w.db.prepare('SELECT delivery_state FROM workspace_event_outbox WHERE id=?');
    w.db.prepare('UPDATE workspace_event_outbox SET created=? WHERE id=?').run(now - deliveryWindowMs, consumer.id);
    assert.deepEqual(await consume(w.env, { type: 'workspace_event', event_id: consumer.id }), acknowledged);
    assert.equal(state.get(consumer.id).delivery_state, 'expired');
    w.db.prepare('UPDATE workspace_event_outbox SET created=? WHERE id=?').run(ancient, cron.id);
    await dispatchDeliveries(w.env);
    assert.equal(state.get(cron.id).delivery_state, 'expired');
    assert.equal(w.queued.length, 2);
    assert.deepEqual(await consume(w.env, { type: 'workspace_event', event_id: cron.id }), acknowledged);
    assert.equal(fetch.mock.callCount(), 0);
    const expiredAudit = w.db.prepare("SELECT target,detail FROM audit WHERE event='backchannel_expired' ORDER BY id").all();
    assert.deepEqual(expiredAudit.map(a => [a.target, JSON.parse(a.detail)]), [consumer, cron].map(row => [
        'app', { client_id: 'app', event_kind: 'workspace_event', event_id: row.id }
    ]));
    w.db.prepare("UPDATE workspace_event_outbox SET delivered_at=?,delivery_state='delivered' WHERE id=?").run(ancient, delivered.id);
    await cleanDeliveryHistory(w.env, now);
    assert.deepEqual(w.rows().map(r => r.id), [consumer.id, pending.id]);
    assert.deepEqual((await deliveryStatus(w.env)).workspace_events, { pending: 1, oldest: pending.created });
});
