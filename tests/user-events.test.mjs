// User lifecycle events to apps, and the audit export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, turnstile, cookieJar } from './support/world.mjs';
import { adminLogin, enrolMfa } from './support/admin.mjs';
import { queue } from '../apps/server/src/services/maintenance.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';
const jarOf = (...parts) => parts.filter(Boolean).join('; ');
const csrfOf = jar => jar.match(/__Host-vi_csrf=([^;]+)/)[1];
const form = (w, path, body, cookie) => w.call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie }, body: new URLSearchParams(body) });
async function eventWorld(t) {
    const w = await world(t), queued = [];
    w.env.LOGOUT_QUEUE = { async send(event) { queued.push(event); } };
    // 'app' opted in to user events; 'other' has a back-channel but did not, so it must hear nothing.
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel', user_events='on' WHERE id='app'; UPDATE clients SET backchannel_uri='https://other.example/backchannel' WHERE id='other'");
    const received = [];
    const app = createClient({ issuer: w.env.ISSUER, clientId: 'app', fetch: (url, init) => w.call(new URL(url).pathname, init) });
    const deliver = async () => {
        await w.drain();
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            if (String(url).startsWith(w.env.ISSUER)) return w.call(new URL(url).pathname, init);
            assert.equal(String(url), 'https://app.example/backchannel', 'only the admitted app is told');
            const form = new URLSearchParams(init.body);
            if (form.has('event_token')) received.push(await app.handleUserEvent(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: init.body })));
            return new Response(null, { status: 204 });
        });
        const batch = { messages: queued.splice(0).map(body => ({ body, ack() {}, retry() { throw new Error('retried ' + body.type); } })) };
        await queue(batch, w.env);
        t.mock.restoreAll();
    };
    return { w, received, deliver };
}
test('a name or email change tells every app that admitted the person, with a verified user-updated event', async t => {
    const { w, received, deliver } = await eventWorld(t);
    const { flow, cookie, code } = await login(w, t);
    await w.exchange(code);
    const jar = jarOf(flow.cookie, cookie);
    assert.equal((await form(w, '/account/profile', { csrf: csrfOf(jar), display_name: 'Ada' }, jar)).status, 200);
    await form(w, '/account/profile', { csrf: csrfOf(jar), display_name: 'Ada' }, jar);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM user_event_outbox').get().n, 1, 'no event when nothing changed');
    await deliver();
    assert.equal(received.length, 1);
    assert.equal(received[0].event, 'user-updated'); assert.deepEqual(received[0].data, { fields: ['name'] }, 'what changed, never the value');
    assert.ok(Number.isInteger(received[0].toe));
    assert.equal(received[0].sub, w.env.DB.db.prepare('SELECT id FROM users').get().id);
    assert.equal(w.env.DB.db.prepare("SELECT delivery_state FROM user_event_outbox").get().delivery_state, 'delivered');
});
test('admin block, unblock, delete and MFA reset each send their event', async t => {
    const { w, received, deliver } = await eventWorld(t); turnstile(t);
    const person = await login(w, t);
    await w.exchange(person.code);
    const jar = jarOf(person.flow.cookie, person.cookie);
    await enrolMfa(w, jar, csrfOf(jar));
    const id = w.env.DB.db.prepare("SELECT id FROM users WHERE email='person@example.com'").get().id;
    const admin = await adminLogin(w);
    assert.equal((await admin.post(`users/${id}/reset-mfa`, { reason: 'Lost phone, checked by call' })).status, 200);
    assert.equal((await admin.post(`users/${id}/block`)).status, 200);
    assert.equal((await admin.post(`users/${id}/unblock`)).status, 200);
    assert.equal((await admin.post(`users/${id}/delete`)).status, 200);
    await deliver();
    // A batch is delivered concurrently, so compare the set; jti and created order the events for the app.
    assert.deepEqual(received.map(r => r.event).sort(), ['mfa-reset', 'user-blocked', 'user-deleted', 'user-unblocked']);
});
test('a person deleting their own account sends user-deleted before their admissions go', async t => {
    const { w, received, deliver } = await eventWorld(t);
    const { flow, cookie, code } = await login(w, t);
    await w.exchange(code);
    const jar = jarOf(flow.cookie, cookie);
    assert.equal((await form(w, '/account/delete', { csrf: csrfOf(jar), confirm_email: 'person@example.com' }, jar)).status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM client_admissions').get().n, 0);
    await deliver();
    assert.deepEqual(received.map(r => r.event), ['user-deleted']);
});
test('the client refuses user events for another app or with an unknown event type', async t => {
    const w = await world(t);
    const { signAgentJwt } = await import('../apps/server/src/agents/grants.mjs');
    const app = createClient({ issuer: w.env.ISSUER, clientId: 'app', fetch: (url, init) => w.call(new URL(url).pathname, init) });
    const now = Math.floor(Date.now() / 1000);
    const sign = (patch = {}, typ = 'secevent+jwt') => signAgentJwt(w.env, { iss: w.env.ISSUER, aud: 'app', sub: 'u', jti: 'j', iat: now, exp: now + 300, toe: now, events: { [`${w.env.ISSUER}/events/user-blocked`]: {} }, ...patch }, typ);
    assert.equal((await app.verifyUserEventToken(await sign())).event, 'user-blocked');
    for (const token of [await sign({ aud: 'other' }), await sign({ events: { [`${w.env.ISSUER}/events/user-hacked`]: {} } }), await sign({}, 'JWT'), await sign({ events: { 'https://evil.example/events/user-blocked': {} } }), await sign({ toe: undefined }),
        await sign({ events: { [`${w.env.ISSUER}/events/user-updated`]: { fields: ['password'] } } })])
        await assert.rejects(app.verifyUserEventToken(token), { code: 'invalid_token' });
});
test('admins export their realm audit log as NDJSON pages', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    w.env.DB.db.exec("INSERT INTO audit(event,detail,created,realm_id) VALUES('elsewhere','{}',0,'acme')");
    const response = await admin.get('audit/export');
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    const rows = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.length > 0 && rows.every(row => row.event !== 'elsewhere'));
    assert.ok(rows.every((row, i) => i === 0 || row.id > rows[i - 1].id));
    assert.equal((await admin.get('audit/export?after=x')).status, 400);
});

test('review: a losing unblock sends no event, and apps without the opt-in or a back-channel get none', async t => {
    const { w, deliver, received } = await eventWorld(t); turnstile(t);
    const person = await login(w, t);
    await w.exchange(person.code);
    const id = w.env.DB.db.prepare("SELECT id FROM users WHERE email='person@example.com'").get().id;
    w.env.DB.db.exec("INSERT INTO client_admissions(user_id,client_id,created) VALUES('" + id + "','other',0)");
    const admin = await adminLogin(w);
    assert.equal((await admin.post(`users/${id}/block`)).status, 200);
    w.env.DB.db.exec(`UPDATE users SET status='deleted' WHERE id='${id}'`);
    await admin.post(`users/${id}/unblock`);
    await deliver();
    assert.deepEqual(received.map(r => r.event), ['user-blocked']);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM user_event_outbox WHERE client_id='other'").get().n, 0);
});
