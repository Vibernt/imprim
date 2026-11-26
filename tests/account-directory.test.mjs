import assert from 'node:assert/strict';
import test from 'node:test';
import { login, world } from './support/world.mjs';
import { csrfOf, joinWorld } from './support/workspace-join.mjs';

const appsPath = '/v1/account/apps', agentsPath = '/v1/account/agents';

function foreignRealm(db) {
    db.exec(`INSERT INTO realms(id,display_name,created) VALUES('foreign','Foreign realm',0);
        INSERT INTO clients(id,realm_id,redirect_uris,initiate_login_uri)
        VALUES('foreign-app','foreign','[]','https://foreign.example.com/start');
        INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES
        ('local-team','default','team','Editorial team',0),('foreign-team','foreign','team','Hidden team',0);`);
}

test('app directory returns only personal, launchable apps and remembers a redeemed sign-in after app logout', async t => {
    const w = await world(t), owner = await login(w, t), other = await login(w, t, 'other@example.com'), db = w.env.DB.db;
    const [person, stranger] = ['person@example.com', 'other@example.com'].map(email => db.prepare('SELECT id FROM users WHERE email=?').get(email).id);
    foreignRealm(db);
    const mark = 'a'.repeat(64);
    db.prepare(`UPDATE clients SET listed=0,initiate_login_uri=?,branding=? WHERE id='app'`)
        .run('https://app.example.com/start', JSON.stringify({ name: 'Notes', summary: 'Team notes', mark }));
    db.exec(`UPDATE clients SET initiate_login_uri='https://tasks.example.com/start' WHERE id='other';
        INSERT INTO clients(id,redirect_uris) VALUES('no-launch','[]');`);
    const admission = db.prepare('INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,?,0)');
    admission.run(stranger, 'other');
    admission.run(person, 'foreign-app');
    admission.run(person, 'no-launch');
    const read = (path, cookie = '') => w.call(path, { headers: { cookie } });
    const post = (path, body, cookie = owner.cookie, headers = {}) => w.post(path, body, cookie, { 'x-csrf-token': csrfOf(cookie), ...headers });
    const app = { id: 'app', name: 'Notes', summary: 'Team notes', mark, href: 'https://app.example.com/start', last_signed_in: null };
    assert.equal((await read(appsPath)).status, 401);
    assert.equal((await w.call(appsPath, { method: 'PUT', headers: { cookie: owner.cookie } })).status, 404);
    assert.deepEqual(await (await read(appsPath, owner.cookie)).json(), { apps: [app] });
    assert.deepEqual((await (await read(appsPath, other.cookie)).json()).apps.map(item => item.id).sort(), ['app', 'other']);
    assert.notEqual((await w.exchange(owner.code, { code_verifier: 'z'.repeat(43) })).status, 200);
    assert.equal((await (await read(appsPath, owner.cookie)).json()).apps[0].last_signed_in, null);
    assert.equal((await w.exchange(owner.code)).status, 200);
    const signedIn = db.prepare(`SELECT last_signed_in FROM client_admissions WHERE user_id=? AND client_id='app'`).get(person).last_signed_in;
    assert.ok(signedIn > 0);
    assert.equal((await (await read(appsPath, other.cookie)).json()).apps.find(item => item.id === 'app').last_signed_in, null);

    const sid = db.prepare('SELECT sid FROM sessions WHERE user_id=?').get(person).sid;
    db.prepare(`INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('foreign-app',?,?,?),('no-launch',?,?,?)`)
        .run(person, sid, signedIn, person, sid, signedIn);
    assert.deepEqual((await (await read('/v1/account/sessions', owner.cookie)).json()).apps.map(item => [item.client_id, item.href]).sort(),
        [['app', app.href], ['no-launch', null]]);
    assert.equal((await read('/v1/account/sessions')).status, 401);
    assert.equal((await w.call('/v1/account/sessions', { method: 'PATCH', headers: { cookie: owner.cookie } })).status, 404);
    assert.equal((await w.post(appsPath, { client_id: 'app' }, owner.cookie)).status, 403);
    assert.equal((await post(appsPath, { client_id: 'app' }, owner.cookie, { origin: 'https://other.example.com' })).status, 403);
    assert.equal((await post(appsPath, { client_id: 'app' }, other.cookie)).status, 404);
    assert.equal((await post(appsPath, { client_id: 'foreign-app' })).status, 404);
    assert.equal((await post(appsPath, { client_id: 'app' })).status, 200);
    assert.deepEqual(await (await read(appsPath, owner.cookie)).json(), { apps: [{ ...app, last_signed_in: signedIn }] });
    assert.equal(db.prepare(`SELECT count(*) AS count FROM app_sessions WHERE client_id='foreign-app'`).get().count, 1);
    await w.drain();
});

test('agent history has independent keysets and never resolves another person or realm', async t => {
    const w = await joinWorld(t), owner = await w.person(), other = await w.person('other@example.com');
    const { db } = w, now = Date.now(), local = 'https://app.example.com/local', foreign = 'https://app.example.com/foreign';
    foreignRealm(db);
    db.prepare(`UPDATE clients SET agent_scope_catalogue=? WHERE id='app'`).run(JSON.stringify({ read: 'Read reports' }));
    db.prepare(`INSERT INTO workspace_resources(resource,workspace_id,client_id,created,name) VALUES
        (?,'local-team','app',0,'Editorial tools'),(?,'foreign-team','app',0,'Hidden tools')`).run(local, foreign);
    const insert = db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,
        method,created,last_used,expires_at,revoked_at,workspace_id) VALUES(?,'https://agent.example.com/metadata',?,?,?,?,?,
        'read removed','email',?,?,?,?,?)`);
    const grant = ({ name, user = owner.user.id, app = 'app', resource = local, workspace = null, method = 'metadata_document',
        expires = now + 60000, revoked = null, created = now }) => {
        const id = crypto.randomUUID();
        insert.run(id, name, method, app, user, resource, created, created, expires, revoked, workspace);
        return id;
    };
    const localId = grant({ name: 'Local' });
    const tampered = [grant({ name: 'Foreign registration', resource: foreign, method: 'dynamic' }),
        grant({ name: 'Foreign choice', workspace: 'foreign-team' })];
    const choice = grant({ name: 'Local choice', resource: 'https://app.example.com/choice', workspace: 'local-team' });
    const foreignId = grant({ name: 'Foreign app', app: 'foreign-app' });
    const otherId = grant({ name: 'Private', user: other.user.id, revoked: now });
    const history = db.prepare(`INSERT INTO agent_revocation_outbox(id,grant_id,app_id,user_id,resource,uri,created,reason)
        VALUES(?,?,'app',?,?,'',?,?)`);
    const reasons = ['agent_replaced', 'workspace_access_ended', 'agent_revoke'];
    const endedIds = reasons.map(reason => {
        const id = grant({ name: reason, revoked: now });
        history.run(crypto.randomUUID(), id, owner.user.id, local, now, reason);
        return id;
    });
    for (let index = 0; index < 51; index++) grant({ name: 'Expired', created: now - index - 1, expires: now - 1 });

    const get = (query = '', cookie = owner.cookie) => w.call(agentsPath + query, { headers: { cookie } });
    const read = async query => {
        const response = await get(query);
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    assert.equal((await get('?status=active', '')).status, 401);
    assert.equal((await get('?status=ended', '')).status, 401);
    assert.equal((await get('?status=all')).status, 400);
    assert.equal((await get('?status=active&status=ended')).status, 400);
    assert.equal((await get('?status=ended&before=bad')).status, 400);
    assert.equal((await w.post(agentsPath, {}, owner.cookie)).status, 404);
    const active = await read('?status=active');
    assert.deepEqual(active.agents.map(item => item.id).sort(), [localId, choice, ...tampered].sort());
    const registered = active.agents.find(item => item.id === localId);
    assert.equal(registered.workspace_name, 'Editorial team');
    assert.equal(registered.resource_name, 'Editorial tools');
    assert.deepEqual(registered.scopes, [{ code: 'read', label: 'Read reports' }, { code: 'removed', label: null }]);
    assert.equal(active.agents.find(item => item.id === choice).workspace_name, 'Editorial team');
    assert.equal(active.agents.find(item => item.id === tampered[0]).host, null);
    for (const id of tampered) assert.equal(active.agents.find(item => item.id === id).workspace_name, null);
    assert.equal(active.agents.find(item => item.id === tampered[0]).resource_name, null);
    const first = await read('?status=ended');
    assert.equal(first.total, 54);
    assert.equal(first.agents.length, 50);
    assert.ok(first.next);
    assert.ok(!Object.hasOwn(first, 'machine_clients'));
    assert.ok(first.agents.every(item => item.id !== otherId && item.status !== 'active'));
    for (const [index, id] of endedIds.entries()) {
        const item = first.agents.find(item => item.id === id);
        assert.equal(item.ended_reason, reasons[index]);
        assert.equal(item.ended_at, now);
    }
    const last = await read(`?status=ended&before=${encodeURIComponent(first.next)}`);
    assert.equal(last.next, null);
    assert.equal(last.agents.length, 4);
    assert.ok(last.agents.every(item => item.ended_at === now - 1 && item.ended_reason === 'expired'));
    assert.equal(new Set([...first.agents, ...last.agents].map(item => item.id)).size, 54);
    for (const grant_id of [foreignId, otherId]) {
        assert.equal((await w.post(`${agentsPath}/revoke`, { grant_id }, owner.cookie, { 'x-csrf-token': owner.csrf })).status, 403);
    }
});
