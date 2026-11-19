import test from 'node:test';
import assert from 'node:assert/strict';
import { error } from './support/agents.mjs';
import { basic } from './support/world.mjs';
import { response, root, setup } from './support/workspaces.mjs';

async function joinedTeam(t) {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const admin = await w.actor('admin@example.com');
    const member = await w.actor('member@example.com');
    const { workspace_id: id } = await w.team(owner);
    w.addMember(id, member, 'admin');
    const path = root + '/' + id;
    const close = (actor = admin, confirm = undefined, auth) =>
        w.api('POST', path + '/close', { actor_token: actor.actor_token, confirm }, auth);
    const audit = () => w.db.prepare("SELECT actor,detail FROM audit WHERE target=? AND event='workspace-closed'").all(id)
        .map(({ actor, detail }) => ({ actor, detail: JSON.parse(detail) }));
    return { ...w, owner, admin, member, id, path, close, audit };
}

test('a nonmember realm admin closes a joined workspace and ends its members’ workspace access', async t => {
    const w = await joinedTeam(t);
    await w.addTasks(w.owner, w.id);
    const resource = 'https://app.example/w/team/mcp';
    await response(await w.api('PUT', w.path + '/resources', { resource }));
    const now = Date.now();
    for (const { id, session } of [w.owner, w.member]) {
        w.db.prepare("INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,'app',?,'workspace')").run(id, now);
        w.db.prepare("INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('app',?,?,?)").run(id, session.sid, now);
        w.db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at)
            VALUES(?,'agent','Agent','dynamic','app',?,?,'read','email',?,?,?)`).run('grant-' + id, id, resource, now, now, now + 60000);
    }
    const closed = await response(await w.close(w.admin, 'Team'));
    assert.equal(closed.status, 'closed');
    assert.equal(closed.version, 4);
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM client_admissions WHERE source='workspace'").get().n, 0);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM app_sessions').get().n, 0);
    const members = [w.owner.id, w.member.id].sort();
    for (const table of ['logout_outbox', 'agent_revocation_outbox']) {
        assert.deepEqual(w.db.prepare(`SELECT user_id FROM ${table} ORDER BY user_id`).all().map(row => row.user_id), members);
    }
    assert.deepEqual(w.db.prepare('SELECT user_id FROM agent_grants WHERE revoked_at IS NOT NULL ORDER BY user_id').all().map(row => row.user_id), members);
    assert.equal(w.db.prepare('SELECT workspace_id FROM workspace_resources WHERE resource=?').get(resource).workspace_id, w.id);
    const events = w.db.prepare("SELECT client_id,payload FROM workspace_event_outbox WHERE event='workspace-closed' ORDER BY client_id").all();
    assert.deepEqual(events.map(row => [row.client_id, JSON.parse(row.payload)]),
        ['app', 'other'].map(app => [app, { workspace_id: w.id, version: 4 }]));
    assert.deepEqual(w.audit(), [{ actor: w.admin.id, detail: { realm_admin: true, client_id: 'app', version: 4 } }]);
    await error(await w.close(w.admin, 'Team'), 'workspace_closed', 409);
    assert.equal(w.audit().length, 1);
});

test('realm-admin close enforces confirmation, live realm authority, client binding, product visibility and holds', async t => {
    const w = await joinedTeam(t);
    await error(await w.close(), 'access_denied', 403);
    assert.deepEqual(await response(await w.close(w.admin, 'Team '), 400),
        { error: 'invalid_request', error_description: 'The confirmation must match the workspace name.' });
    for (const invalid of [null, 42, {}, 'a'.repeat(121), 'Team\0']) {
        await error(await w.close(w.admin, invalid), 'invalid_request', 400);
    }
    w.db.exec("UPDATE clients SET workspace_admin='off' WHERE id='app'");
    await error(await w.close(w.admin, 'Team'), 'access_denied', 403);
    w.db.exec("UPDATE clients SET workspace_admin='on'");
    await error(await w.close(w.member, 'Team'), 'access_denied', 403);
    w.db.prepare('UPDATE users SET email_verified=0 WHERE id=?').run(w.admin.id);
    await error(await w.close(w.admin, 'Team'), 'access_denied', 403);
    w.db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(w.admin.id);

    w.db.exec(`INSERT INTO realms(id,issuer,display_name,config,created) VALUES('elsewhere','https://elsewhere.example','Elsewhere','{}',0);
        INSERT INTO admins(realm_id,email,role,created) VALUES('elsewhere','foreign@example.com','realm',0)`);
    await error(await w.close(await w.actor('foreign@example.com'), 'Team'), 'access_denied', 403);
    const other = await w.actor(w.admin.email, 'other');
    await error(await w.close(other, 'Team', basic('other')), 'not_found', 404);
    await error(await w.close(other, 'Team'), 'invalid_request', 400);
    await response(await w.api('PUT', w.path + '/holds', { reason: 'Balance due' }));
    await error(await w.close(w.admin, 'Team'), 'workspace_held', 409);
    assert.equal((await response(await w.api('GET', w.path))).status, 'active');
    assert.deepEqual(w.audit(), []);
});

test('close rechecks the live name and realm-admin roster in the guarded write', async t => {
    const w = await joinedTeam(t);
    const batch = w.env.DB.batch;
    const rename = t.mock.method(w.env.DB, 'batch', statements => {
        w.db.prepare("UPDATE workspaces SET name='Renamed' WHERE id=?").run(w.id);
        return batch(statements);
    });
    await error(await w.close(w.admin, 'Team'), 'invalid_request', 400);
    rename.mock.restore();
    t.mock.method(w.env.DB, 'batch', statements => {
        w.db.prepare('DELETE FROM admins WHERE email=?').run(w.admin.email);
        return batch(statements);
    });
    await error(await w.close(w.admin, 'Renamed'), 'access_denied', 403);
    assert.deepEqual(w.audit(), []);
});

test('owners can close with or without confirmation and use owner authority even when on the admin roster', async t => {
    const w = await joinedTeam(t);
    w.addMember(w.id, w.admin, 'owner');
    await error(await w.close(w.admin, 'Wrong'), 'invalid_request', 400);
    assert.equal((await response(await w.close(w.admin, 'Team'))).status, 'closed');
    assert.deepEqual(w.audit(), [{ actor: w.admin.id, detail: { client_id: 'app', version: 2 } }]);
    const { workspace_id } = await w.team(w.owner);
    w.db.exec("UPDATE clients SET workspace_admin='off' WHERE id='app'");
    assert.equal((await response(await w.api('POST', root + '/' + workspace_id + '/close',
        { actor_token: w.owner.actor_token }))).status, 'closed');
});
