import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { adminLogin } from './support/admin.mjs';
import { login, turnstile, world } from './support/world.mjs';

test('audit filters intersect by date, event and subject and resolve current realm labels', async t => {
    const w = await world(t), person = await login(w, t), admin = await adminLogin(w), db = w.env.DB.db;
    const user = db.prepare("SELECT id FROM users WHERE email='person@example.com'").get().id;
    db.exec(`UPDATE clients SET branding='{"name":"Notes"}' WHERE id='app';
        INSERT INTO realms(id,issuer,display_name,config,created) VALUES('elsewhere','https://elsewhere.example.com','Elsewhere','{}',0);
        INSERT INTO clients(id,realm_id,redirect_uris,branding) VALUES('foreign-app','elsewhere','[]','{"name":"Foreign App"}');`);
    const insert = db.prepare('INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES(?,?,?,?,?,?)');
    const start = Date.parse('2026-01-01T00:00:00Z'), end = Date.parse('2026-01-02T00:00:00Z');
    insert.run('admin_client_update', user, 'app', '{"note":"before"}', start - 1, 'default');
    insert.run('admin_client_update', user, 'app', '{"note":"start"}', start, 'default');
    insert.run('admin_client_update', user, 'app', '{"note":"end of day"}', end - 1, 'default');
    insert.run('admin_client_update', user, 'app', '{"note":"next day"}', end, 'default');
    insert.run('admin_client_update', user, 'foreign-app', '{}', start, 'default');
    insert.run('admin_client_update', user, 'app', '{"note":"other realm"}', end - 1, 'elsewhere');
    insert.run('invented_event', user, 'app', '{}', start, 'default');
    insert.run('code_replay', 'app', null, '{}', start, 'default');
    insert.run('admin_block', user, user, '{}', start, 'default');
    const filters = new URLSearchParams({ actor: user, target: 'app', event: 'admin_client_update', from: '2026-01-01', to: '2026-01-01' });
    const path = 'audit?' + filters;
    const response = await admin.get(path);
    assert.equal(response.status, 200);
    const { audit } = await response.json();
    assert.deepEqual(audit.map(row => [row.created, row.actor_label, row.target_label]),
        [[end - 1, 'person@example.com', 'Notes'], [start, 'person@example.com', 'Notes']]);
    assert.equal((await (await admin.get('audit?event=admin_client_update&target=foreign-app')).json()).audit[0].target_label, null);
    assert.equal((await (await admin.get('audit?event=code_replay')).json()).audit[0].actor_label, 'Notes');
    assert.equal((await (await admin.get('audit?event=admin_block')).json()).audit[0].target_label, 'person@example.com');
    assert.equal((await (await admin.get('audit?event=invented_event')).json()).audit[0].event, 'invented_event');
    const older = await (await admin.get(path + '&before=' + audit[0].id)).json();
    assert.deepEqual(older.audit.map(row => row.id), [audit[1].id]);
    for (const query of ['from=2026-02-30', 'to=invalid', 'from=2026-01-02&to=2026-01-01', 'event=bad%20event']) {
        assert.equal((await admin.get('audit?' + query)).status, 400, query);
    }
    const exportRow = JSON.parse((await (await admin.get('audit/export?after=' + (audit[0].id - 1))).text()).split('\n')[0]);
    assert.deepEqual(Object.keys(exportRow), ['id', 'event', 'actor', 'target', 'detail', 'created']);
    const foreignOrigin = await w.call('/admin/api/' + path, { headers: { cookie: admin.cookie, origin: 'https://foreign.example.com' } });
    assert.equal(foreignOrigin.headers.get('access-control-allow-origin'), null);
    assert.equal((await w.call('/admin/api/' + path, { headers: { cookie: person.cookie } })).status, 403);
});

test('users list shows last audited sign-in and detail lists safe sign-in and verification methods', async t => {
    const w = await world(t), { flow } = await login(w, t), admin = await adminLogin(w), db = w.env.DB.db;
    assert.ok(flow.request_id);
    const { id } = db.prepare("SELECT id FROM users WHERE email='person@example.com'").get();
    const signedIn = db.prepare("SELECT max(created) AS time FROM audit WHERE event='sign_in' AND actor=?").get(id).time;
    db.prepare("UPDATE users SET display_name='Example Person',locale='es' WHERE id=?").run(id);
    db.prepare("INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES('github','42',?,'example-person',0)").run(id);
    db.prepare("INSERT INTO user_passwords VALUES(?,'pbkdf2-sha256',100000,'salt','hash',0,0)").run(id);
    db.prepare("INSERT INTO mfa_factors(id,user_id,type,name,sealed_secret,confirmed,created) VALUES('example-factor',?,'totp','Phone','sealed-value',1,0)").run(id);
    db.prepare("INSERT INTO recovery_codes(user_id,hash,created) VALUES(?,'hidden-recovery-hash',0)").run(id);
    db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at)
        VALUES('record-grant','agent','Example Agent','dynamic','app',?,'https://app.example.com/mcp','read','email',0,0,1000)`).run(id);
    const person = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const expired = (await issueSession(w.env, person, 'email')).session;
    db.prepare('UPDATE sessions SET expires_at=0 WHERE sid=?').run(expired.sid);
    const list = await (await admin.get('users?q=person%40example.com')).json();
    assert.equal(list.total, 1);
    assert.deepEqual([list.users[0].display_name, list.users[0].last_sign_in], ['Example Person', signedIn]);
    const { users } = await (await admin.get('users?q=admin%40example.com')).json();
    assert.ok(users[0].last_sign_in > 0);
    const response = await admin.get('users/' + id);
    const raw = await response.text(), detail = JSON.parse(raw);
    assert.deepEqual(detail.sign_in_methods, ['email', 'password', 'github']);
    assert.deepEqual(detail.verification_methods, ['totp', 'recovery']);
    assert.equal(detail.locale, 'es');
    assert.equal(detail.agent_grant_count, 1);
    assert.equal(detail.sessions.length, 2);
    assert.ok(detail.sessions.some(session => session.auth_time * 1000 < session.expires_at));
    assert.ok(detail.sessions.some(session => session.sid === expired.sid && session.expires_at === 0));
    assert.doesNotMatch(raw, /hidden-recovery-hash|sealed-value/);
    const headers = { cookie: admin.cookie, origin: 'https://elsewhere.example.com' };
    for (const path of ['users', 'users/' + id]) {
        assert.equal((await w.call('/admin/api/' + path, { headers })).headers.get('access-control-allow-origin'), null);
    }
});

test('sign-up summary and configuration delivery status are confined to actionable work in the realm', async t => {
    const w = await world(t), db = w.env.DB.db;
    turnstile(t);
    const admin = await adminLogin(w);
    db.exec(`INSERT INTO realms(id,issuer,display_name,config,created) VALUES('other-realm','https://other.example.com','Other','{}',0);
        INSERT INTO clients(id,realm_id,redirect_uris) VALUES('other-app','other-realm','[]');`);
    const insert = db.prepare(`INSERT INTO signup_requests(id,realm_id,client_id,product,email,workspace_name,locale,status,created,verified_at)
        VALUES(?,?,?,'notes',?,'Team','en',?,?,?)`);
    const now = Date.now();
    for (const [id, realm, clientId, status, time] of [
        ['live', 'default', 'app', 'pending', now], ['expired', 'default', 'app', 'pending', now - 31 * 86400000],
        ['approved', 'default', 'app', 'approved', now], ['foreign', 'other-realm', 'other-app', 'pending', now],
    ]) {
        insert.run(id, realm, clientId, id + '@example.com', status, time, time);
    }
    assert.deepEqual(await (await admin.get('signups/summary')).json(), { pending: 1 });
    assert.deepEqual((await (await admin.get('signups')).json()).requests.map(request => request.id), ['live']);
    db.prepare("UPDATE signup_requests SET status='declined' WHERE id='live'").run();
    assert.deepEqual(await (await admin.get('signups/summary')).json(), { pending: 0 });

    const event = db.prepare(`INSERT INTO workspace_event_outbox(id,client_id,workspace_id,event,created,version)
        VALUES(?,?,'fixture','workspace-updated',?,1)`);
    event.run('local-event', 'app', now);
    event.run('foreign-event', 'other-app', now);
    const response = await admin.get('settings');
    assert.equal(response.status, 200, await response.clone().text());
    const { delivery } = await response.json();
    assert.deepEqual(delivery.workspace_events, { pending: 1, oldest: now });
    assert.deepEqual(delivery.clients_missing_backchannel, ['app']);
});
