import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { scheduled } from '../apps/server/src/services/maintenance.mjs';
const day = 86400000;
for (const table of ['logout_outbox','agent_revocation_outbox']) test(`${table} cleanup is bounded and retains pending and last 30 days of delivery history`, async t => {
    const w = await world(t), now = Date.now(); t.mock.method(Date, 'now', () => now);
    w.env.LOGOUT_QUEUE = { async send() {} };
    const insert = (id, deliveredAt) => table === 'logout_outbox'
        ? w.env.DB.db.prepare('INSERT INTO logout_outbox(id,client_id,user_id,created,delivered_at) VALUES(?,?,?,?,?)').run(id,'app','person',now-90*day,deliveredAt)
        : w.env.DB.db.prepare('INSERT INTO agent_revocation_outbox(id,grant_id,app_id,user_id,resource,uri,created,delivered_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'grant','app','person','https://app.example/mcp','https://app.example/logout',now-90*day,deliveredAt);
    for (let i=0; i<505; i++) insert('old-'+i, now-31*day);
    insert('recent',now-7*day); insert('boundary',now-30*day); insert('pending',null);
    await scheduled(w.env);
    assert.equal(w.env.DB.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 8);
    for (const id of ['recent','boundary','pending']) assert.ok(w.env.DB.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id));
    await scheduled(w.env);
    assert.equal(w.env.DB.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 3);
});

test('association within 30 days survives identity expiry and produces a logout token', async t => {
    const { login } = await import('./support/world.mjs');
    const { logoutStatements, deliverLogout } = await import('../apps/server/src/oidc/backchannel.mjs');
    const w = await world(t), signed = await login(w, t);
    await w.exchange(signed.code);
    const association = w.env.DB.db.prepare('SELECT * FROM app_sessions').get();
    const now = Date.now(); t.mock.method(Date, 'now', () => now);
    w.env.DB.db.prepare('UPDATE sessions SET expires_at=0').run();
    w.env.DB.db.prepare('UPDATE app_sessions SET created=?').run(now - 30*day + 1);
    await scheduled(w.env);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM app_sessions').get().n, 1);
    await w.env.DB.batch(logoutStatements(w.env, association.user_id));
    const event = w.env.DB.db.prepare('SELECT * FROM logout_outbox').get();
    assert.equal(event.user_id, association.user_id);
    w.env.DB.db.prepare("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'").run();
    let sent = 0;
    t.mock.method(globalThis, 'fetch', async (_uri, init) => {
        sent++;
        const token = new URLSearchParams(init.body).get('logout_token');
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
        assert.equal(claims.sid, association.sid);
        return new Response(null, { status: 204 });
    });
    await deliverLogout(w.env, { body: { event_id: event.id } });
    assert.equal(sent, 1);
});

test('expired association is cleaned in batches of 500 and produces no logout event', async t => {
    const w = await world(t), now = Date.now(); t.mock.method(Date, 'now', () => now);
    const { logoutStatements } = await import('../apps/server/src/oidc/backchannel.mjs');
    const insert = w.env.DB.db.prepare('INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES(?,?,?,?)');
    await w.env.DB.prepare("INSERT INTO users(id,email,status,created) VALUES('person','person@example.com','active',?)").bind(now).run();
    for (let i=0; i<505; i++) insert.run('app', 'person', `old-${i}`, now - 30*day);
    insert.run('app', 'person', 'current', now - 30*day + 1);
    await scheduled(w.env);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM app_sessions').get().n, 6);
    await scheduled(w.env);
    assert.deepEqual(w.env.DB.db.prepare('SELECT sid FROM app_sessions').all().map(row => row.sid), ['current']);
    insert.run('app', 'person', 'expired-uncleaned', now - 30*day);
    await w.env.DB.batch(logoutStatements(w.env, 'person'));
    assert.equal(w.env.DB.db.prepare('SELECT sid FROM logout_outbox').get().sid, 'current');
    insert.run('app', 'person', 'expired-again', now - 30*day);
    await w.env.DB.batch(logoutStatements(w.env, 'person'));
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM logout_outbox').get().n, 1);
});
