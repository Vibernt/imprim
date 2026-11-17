import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/server/src/worker.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { signIdToken, signJwt } from '../apps/server/src/oidc/jwt.mjs';
import { b64url, from64, sha256 } from '../apps/server/src/lib/crypto.mjs';
import { forgetRealms, realmEnvForClient } from '../apps/server/src/realms/realm.mjs';
import { basic } from './support/world.mjs';
import { response, root, setup } from './support/workspaces.mjs';
import { error } from './support/agents.mjs';

const deadline = 30 * 86400000;

test('workspace and membership reads need the realm switch, a confidential shared app, and its product', async t => {
    const w = await setup(t, { enabled: false });
    await error(await w.api('GET', '/v1/memberships?sub=user'), 'not_found', 404);
    w.db.prepare("UPDATE realms SET config=json_set(config,'$.workspaces','on')").run();
    const owner = await w.actor('owner@example.com');
    const created = await w.team(owner);
    assert.match(created.workspace_id, /^ws_[0-9a-f]{32}$/);
    assert.deepEqual(created, { workspace_id: created.workspace_id, name: 'Team', kind: 'team', status: 'active', products: ['notes'], version: 1 });
    const path = root + '/' + created.workspace_id;
    await error(await w.api('GET', path, undefined, null), 'invalid_client', 401);
    await error(await w.api('GET', path, undefined, basic('app', 'bad')), 'invalid_client', 401);
    await error(await w.api('GET', path, undefined, basic('other')), 'not_found', 404);
    const fromOther = await w.actor(owner.email, 'other');
    await error(await w.api('PATCH', path, { name: 'Wrong product', actor_token: fromOther.actor_token }, basic('other')), 'not_found', 404);
    await error(await w.api('GET', path + '/members', undefined, basic('other')), 'not_found', 404);
    await error(await w.api('GET', path + '/invitations', undefined, basic('other')), 'not_found', 404);
    assert.deepEqual(await response(await w.api('GET', '/v1/memberships?sub=' + owner.id, undefined, basic('other'))), { memberships: [] });
    assert.deepEqual(await response(await w.api('GET', path)), created);
    assert.deepEqual(await response(await w.api('GET', '/v1/memberships?sub=' + owner.id)), {
        memberships: [{ workspace_id: created.workspace_id, name: 'Team', kind: 'team', role: 'owner', products: ['notes'], version: 1 }]
    });
    for (const suffix of ['', '?sub=', '?sub=one&sub=two']) await error(await w.api('GET', '/v1/memberships' + suffix), 'invalid_request', 400);
    await error(await w.api('GET', '/v1/memberships?sub=one&client_id=app&client_secret=secret', undefined, null), 'invalid_client', 401);
    await error(await w.call(path, { headers: { accept: 'text/html' } }), 'invalid_client', 401);
    await error(await w.api('GET', path + '/other'), 'not_found', 404);

    w.db.prepare("UPDATE clients SET workspaces='app' WHERE id='app'").run();
    await error(await w.api('GET', path), 'not_found', 404);
    w.db.prepare("UPDATE clients SET workspaces='shared',product=NULL WHERE id='app'").run();
    await error(await w.api('GET', path), 'not_found', 404);
    w.db.prepare("UPDATE clients SET product='notes',secret_hash=NULL WHERE id='app'").run();
    await error(await w.api('GET', path), 'invalid_client', 401);
});

test('workspace routes use the client bucket and accept body credentials only for JSON mutations', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const keys = [];
    w.env.API_LIMITER.limit = async ({ key }) => { keys.push(key); return { success: keys.length < 6 }; };
    const created = await w.team(owner, { client_id: 'app', client_secret: 'secret' }, null);
    const path = root + '/' + created.workspace_id;
    await error(await w.api('PATCH', path, { client_id: 'app', client_secret: 'secret', actor_token: owner.actor_token }), 'invalid_client', 401);
    await error(await w.api('PATCH', path, { client_id: 'app', client_secret: '', actor_token: owner.actor_token }), 'invalid_client', 401);
    await error(await w.call(path, { method: 'PATCH', headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=bad' }), 'invalid_request', 415);
    await response(await w.api('GET', path + '/members'));
    await error(await w.api('GET', path), 'rate_limit', 429);
    const client = await sha256('client:app'), address = await sha256('ip:unavailable');
    assert.deepEqual(keys, [client, address, address, address, client, client]);
});

test('actor tokens must be signed by this realm, issued to the app, and point to a live active user session', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com'), somebody = await w.actor('somebody@example.com');
    const { workspace_id } = await w.team(owner);
    const path = root + '/' + workspace_id;
    const now = Math.floor(Date.now() / 1000), claim = {
        iss: w.env.ISSUER, aud: 'app', azp: 'app', sid: owner.session.sid, sub: owner.id, iat: now - 1800, exp: now - 1200
    };
    const expired = await signJwt(w.env, claim);
    const [header, , signature] = expired.split('.');
    const forged = [header, b64url(new TextEncoder().encode(JSON.stringify({ ...claim, exp: now + 300 }))), signature].join('.');
    const patch = (actor_token, name = 'New name') => w.api('PATCH', path, { name, actor_token });
    for (const token of [undefined, 'garbage', forged, await signJwt(w.env, { ...claim, aud: 'other', azp: 'other' }),
        await signJwt(w.env, { ...claim, iss: 'https://other.example' }), await signJwt(w.env, { ...claim, sid: somebody.session.sid })]) {
        await error(await patch(token), 'invalid_request', 400);
    }
    assert.equal((await response(await patch(expired))).version, 2);
    w.db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(owner.id);
    await error(await patch(expired), 'invalid_request', 400);
    w.db.prepare("UPDATE users SET status='active' WHERE id=?").run(owner.id);
    w.db.prepare('UPDATE sessions SET expires_at=0 WHERE sid=?').run(owner.session.sid);
    await error(await patch(expired), 'invalid_request', 400);
    w.db.prepare('DELETE FROM sessions WHERE sid=?').run(owner.session.sid);
    await error(await patch(expired), 'invalid_request', 400);
    assert.equal((await response(await w.api('GET', path))).version, 2);
});

test('a changed session, app policy, or failed audit rolls back workspace changes and outbox rows', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const { workspace_id } = await w.team(owner);
    const path = root + '/' + workspace_id;
    const patch = () => w.api('PATCH', path, { name: 'New name', actor_token: owner.actor_token });
    const dbBatch = w.env.DB.batch.bind(w.env.DB);
    let before = () => w.db.prepare("UPDATE clients SET workspaces='app' WHERE id='app'").run();
    const intercepted = t.mock.method(w.env.DB, 'batch', async statements => {
        before();
        return dbBatch(statements);
    });
    await error(await patch(), 'not_found', 404);
    w.db.prepare("UPDATE clients SET workspaces='shared' WHERE id='app'").run();
    before = () => { w.db.prepare('DELETE FROM sessions WHERE sid=?').run(owner.session.sid); };
    await error(await patch(), 'invalid_request', 400);
    intercepted.mock.restore();
    const again = await w.actor(owner.email);
    w.db.exec(`CREATE TRIGGER refuse_workspace_audit BEFORE INSERT ON audit WHEN NEW.event='workspace-updated'
        BEGIN SELECT RAISE(ABORT, 'audit write refused'); END`);
    const logged = t.mock.method(console, 'error', () => {});
    const failedAudit = await w.call(path, { method: 'PATCH', headers: { authorization: basic(), 'content-type': 'application/json', 'accept-language': 'fr' },
        body: JSON.stringify({ name: 'New name', actor_token: again.actor_token }) });
    assert.equal((await failedAudit.clone().json()).error_description, 'The request could not be completed.');
    await error(failedAudit, 'server_error', 500);
    assert.equal(logged.mock.callCount(), 1);
    assert.equal((await response(await w.api('GET', path))).version, 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM audit WHERE target=?').get(workspace_id).n, 1);
});

test('team bootstrap either adds the actor as owner or records one pending owner invitation', async t => {
    const w = await setup(t);
    const creator = await w.actor('creator@example.com');
    const call = body => w.api('POST', root, { name: 'Team', products: ['notes'], first_owner_email: 'OWNER@example.com',
        actor_token: creator.actor_token, ...body });
    await error(await call({ name: ' '.repeat(10) }), 'invalid_request', 400);
    for (const products of [['tasks'], ['notes', 'tasks'], ['notes', 'notes'], [], null, 'notes']) {
        assert.deepEqual(await response(await call({ products }), 400), {
            error: 'invalid_request', error_description: 'An app may only use its own product.'
        });
    }
    await error(await call({ kind: 'other' }), 'invalid_request', 400);
    w.db.prepare("UPDATE clients SET workspace_admin='off' WHERE id='app'").run();
    await error(await call({}), 'access_denied', 403);
    w.db.prepare("UPDATE clients SET workspace_admin='on' WHERE id='app'").run();
    const pending = [];
    const req = new Request(w.env.ISSUER + root, { method: 'POST', headers: { authorization: basic(), 'content-type': 'application/json' },
        body: JSON.stringify({ name: ' Team ', first_owner_email: 'OWNER@example.com', actor_token: creator.actor_token }) });
    const start = Date.now();
    const created = await response(await worker.fetch(req, w.env, { waitUntil(promise) { pending.push(promise); } }), 201);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.equal(created.name, 'Team');
    assert.deepEqual(created.products, ['notes']);
    const path = root + '/' + created.workspace_id;
    assert.deepEqual(await response(await w.api('GET', path + '/members')), { members: [], version: 1, next_cursor: null });
    const { invitations: [invite] } = await response(await w.api('GET', path + '/invitations'));
    assert.equal(invite.role, 'owner');
    assert.equal(invite.email, 'owner@example.com');
    assert.ok(invite.expires_at >= start + deadline && invite.expires_at <= Date.now() + deadline);
    assert.equal(w.db.prepare('SELECT invited_by FROM workspace_invitations WHERE id=?').get(invite.invitation_id).invited_by, creator.id);
});

test('members page oldest first with a stable cursor that preserves imported principal IDs', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const { workspace_id } = await w.team(owner);
    const path = root + '/' + workspace_id + '/members';
    const imported = 'legacy/' + 'zé'.repeat(93);
    w.db.prepare("INSERT INTO users(id,realm_id,email,email_verified,status,created) VALUES(?,'default','imported@example.com',1,'active',0)").run(imported);
    w.addMember(workspace_id, { id: imported }, 'viewer', 1);
    const second = await w.actor('second@example.com');
    w.addMember(workspace_id, second, 'member', 1);
    const page1 = await response(await w.api('GET', path + '?limit=1'));
    assert.deepEqual(page1.members, [{ sub: second.id, email: second.email, role: 'member' }]);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(from64(page1.next_cursor))), [1, second.id]);
    const page2 = await response(await w.api('GET', path + '?limit=1&cursor=' + page1.next_cursor));
    assert.deepEqual(page2.members, [{ sub: imported, email: 'imported@example.com', role: 'viewer' }]);
    const page3 = await response(await w.api('GET', path + '?limit=1&cursor=' + page2.next_cursor));
    assert.deepEqual(page3, { members: [{ sub: owner.id, email: owner.email, role: 'owner' }], next_cursor: null, version: 1 });
    for (const query of ['limit=0', 'limit=201', 'limit=01', 'cursor=bad', 'cursor=', 'limit=1&limit=1'])
        await error(await w.api('GET', path + '?' + query), 'invalid_request', 400);
    await response(await w.api('POST', path + '/' + encodeURIComponent(imported), { role: 'admin', actor_token: owner.actor_token }));
    assert.equal((await response(await w.api('GET', path + '?limit=2'))).members[1].role, 'admin');
});

test('invitations require an admin and owner invitations require an owner; replacing and revoking are versioned', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com'), admin = await w.actor('admin-member@example.com');
    const member = await w.actor('member@example.com'), viewer = await w.actor('viewer@example.com');
    const { workspace_id } = await w.team(owner);
    const path = root + '/' + workspace_id + '/invitations';
    for (const [person, role] of [[admin, 'admin'], [member, 'member'], [viewer, 'viewer']]) w.addMember(workspace_id, person, role);
    const invite = (actor, role, email = 'Person@Example.COM') => w.api('POST', path, { email, role, actor_token: actor.actor_token });
    for (const who of [member, viewer]) await error(await invite(who, 'viewer'), 'access_denied', 403);
    await error(await invite(admin, 'owner'), 'access_denied', 403);
    await error(await invite(owner, 'invalid'), 'invalid_request', 400);
    await error(await invite(owner, 'owner', 'not-email'), 'invalid_request', 400);
    const first = await response(await invite(owner, 'owner'), 201);
    const replacement = await response(await invite(admin, 'viewer'), 201);
    assert.notEqual(first.invitation_id, replacement.invitation_id);
    assert.deepEqual(await response(await w.api('GET', path)), { invitations: [{ ...replacement, email: 'person@example.com', role: 'viewer' }] });
    assert.ok(w.db.prepare('SELECT revoked_at FROM workspace_invitations WHERE id=?').get(first.invitation_id).revoked_at);
    const revoke = (who, id) => w.api('DELETE', path + '/' + id, { actor_token: who.actor_token });
    await error(await revoke(member, replacement.invitation_id), 'access_denied', 403);
    await error(await revoke(owner, first.invitation_id), 'not_found', 404);
    const another = await w.team(owner);
    await error(await w.api('DELETE', root + '/' + another.workspace_id + '/invitations/' + replacement.invitation_id,
        { actor_token: owner.actor_token }), 'not_found', 404);
    assert.equal((await response(await revoke(admin, replacement.invitation_id))).version, 4);
    assert.deepEqual(await response(await w.api('GET', path)), { invitations: [] });
    const expired = await response(await invite(admin, 'member'), 201);
    w.db.prepare('UPDATE workspace_invitations SET expires_at=0 WHERE id=?').run(expired.invitation_id);
    assert.deepEqual(await response(await w.api('GET', path)), { invitations: [] });
    await error(await revoke(owner, expired.invitation_id), 'not_found', 404);
    assert.equal((await response(await invite(owner, 'member'), 201)).expires_at >= Date.now() + deadline - 1000, true);
    await w.drain();
});

test('member writes enforce owner authority and last owner; members may leave themselves', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com'), admin = await w.actor('admin-member@example.com');
    const member = await w.actor('member@example.com'), outside = await w.actor('outside@example.com');
    const { workspace_id } = await w.team(owner);
    const path = root + '/' + workspace_id;
    w.addMember(workspace_id, member, 'member');
    w.addMember(workspace_id, admin, 'admin');
    const role = (who, target, role) => w.api('POST', path + '/members/' + target.id, { role, actor_token: who.actor_token });
    const remove = (who, target) => w.api('DELETE', path + '/members/' + target.id, { actor_token: who.actor_token });
    await error(await w.api('PATCH', path, { name: 'Bad', actor_token: member.actor_token }), 'access_denied', 403);
    assert.equal((await response(await w.api('PATCH', path, { name: 'Good', actor_token: admin.actor_token }))).version, 2);
    await error(await role(admin, member, 'owner'), 'access_denied', 403);
    await error(await role(admin, owner, 'member'), 'access_denied', 403);
    await error(await remove(admin, owner), 'access_denied', 403);
    await error(await remove(owner, owner), 'last_owner', 409);
    await error(await role(owner, owner, 'admin'), 'last_owner', 409);
    await error(await role(member, member, 'admin'), 'access_denied', 403);
    await error(await role(owner, outside, 'member'), 'not_found', 404);
    await error(await remove(member, admin), 'access_denied', 403);
    await error(await remove(outside, outside), 'access_denied', 403);
    assert.equal((await response(await role(admin, member, 'viewer'))).version, 3);
    assert.equal((await response(await remove(member, member))).version, 4);
    assert.equal((await response(await remove(admin, admin))).version, 5);
    const events = w.db.prepare('SELECT event,user_id,version,payload FROM workspace_event_outbox WHERE workspace_id=? ORDER BY version').all(workspace_id);
    assert.deepEqual(events.map(e => [e.version, e.event, e.user_id]), [
        [1, 'workspace-member-added', owner.id], [2, 'workspace-updated', null], [3, 'workspace-role-changed', member.id],
        [4, 'workspace-member-removed', member.id], [5, 'workspace-member-removed', admin.id]
    ]);
    assert.deepEqual(events.map(e => JSON.parse(e.payload)), [
        { workspace_id, version: 1, role: 'owner' }, { workspace_id, version: 2, name: 'Good' },
        { workspace_id, version: 3, role: 'viewer' }, { workspace_id, version: 4 }, { workspace_id, version: 5 }
    ]);
    const audit = w.db.prepare('SELECT actor,event,detail FROM audit WHERE target=? ORDER BY id').all(workspace_id);
    assert.deepEqual(audit.map(a => [a.actor, a.event, JSON.parse(a.detail).version]), [
        [owner.id, 'workspace-created', 1], [admin.id, 'workspace-updated', 2], [admin.id, 'workspace-role-changed', 3],
        [member.id, 'workspace-member-removed', 4], [admin.id, 'workspace-member-removed', 5]
    ]);
});

test('concurrent demotions cannot leave a team without an owner', async t => {
    const w = await setup(t);
    const first = await w.actor('first@example.com'), second = await w.actor('second@example.com');
    const { workspace_id } = await w.team(first);
    const path = root + '/' + workspace_id + '/members/';
    w.addMember(workspace_id, second, 'member');
    await response(await w.api('POST', path + second.id, { role: 'owner', actor_token: first.actor_token }));
    const outcomes = await Promise.all([first, second].map(actor => w.api('POST', path + actor.id, { role: 'member', actor_token: actor.actor_token })));
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    await error(outcomes.find(r => r.status === 409), 'last_owner', 409);
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM workspace_members WHERE workspace_id=? AND role='owner'").get(workspace_id).n, 1);
    assert.equal(w.db.prepare('SELECT version FROM workspaces WHERE id=?').get(workspace_id).version, 3);
});

test('a personal workspace has one owner, takes no invitations, and stays unique after close', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const body = { name: 'Personal', kind: 'personal', products: ['tasks'], actor_token: owner.actor_token };
    w.db.prepare("UPDATE clients SET workspace_admin='off',personal_workspaces='off' WHERE id='app'").run();
    await error(await w.api('POST', root, body), 'access_denied', 403);
    w.db.prepare("UPDATE clients SET personal_workspaces='on' WHERE id='app'").run();
    const races = await Promise.all([w.api('POST', root, body), w.api('POST', root, body)]);
    const { workspace_id, products, version } = await response(races.find(r => r.status === 201), 201);
    await error(races.find(r => r.status !== 201), 'personal_workspace_exists', 409);
    assert.deepEqual(products, ['notes']);
    assert.equal(version, 1);
    const path = root + '/' + workspace_id;
    await error(await w.api('POST', path + '/invitations', { email: 'another@example.com', role: 'viewer', actor_token: owner.actor_token }),
        'personal_workspace', 409);
    await error(await w.api('DELETE', path + '/members/' + owner.id, { actor_token: owner.actor_token }), 'last_owner', 409);
    const closed = await response(await w.api('POST', path + '/close', { actor_token: owner.actor_token }));
    assert.equal(closed.status, 'closed');
    assert.equal(closed.version, 2);
    await error(await w.api('POST', root, body), 'personal_workspace_exists', 409);
    assert.deepEqual(await response(await w.api('GET', '/v1/memberships?sub=' + owner.id)), { memberships: [] });
});

test('products require the app flag and an owner or a verified realm admin, and notify the before-and-after recipients', async t => {
    const w = await setup(t);
    const creator = await w.actor('creator@example.com'), admin = await w.actor('admin@example.com');
    const workspaceAdmin = await w.actor('workspace-admin@example.com');
    const { workspace_id } = await w.team(creator);
    const path = root + '/' + workspace_id;
    w.addMember(workspace_id, workspaceAdmin, 'admin');
    w.db.prepare("INSERT INTO realms(id,issuer,display_name,config,created) VALUES('second','https://second.example','Second','{\"workspaces\":\"on\"}',0)").run();
    const addApp = w.db.prepare(`INSERT INTO clients(id,secret_hash,redirect_uris,post_logout_uris,
        workspaces,product,backchannel_uri,realm_id) VALUES(?,?,'[]','[]',?,?,?,?)`);
    const secret = await sha256('secret');
    addApp.run('notes-console', secret, 'shared', 'notes', 'https://console.example/events', 'default');
    addApp.run('notes-private', secret, 'app', 'notes', 'https://private.example/events', 'default');
    addApp.run('tasks-no-uri', secret, 'shared', 'tasks', null, 'default');
    addApp.run('tasks-abroad', secret, 'shared', 'tasks', 'https://abroad.example/events', 'second');
    addApp.run('docs', secret, 'shared', 'docs', 'https://docs.example/events', 'default');
    addApp.run('tasks-local', secret, 'shared', 'tasks', 'https://tasks.example/events', 'default');
    const initial = w.db.prepare('SELECT client_id FROM workspace_event_outbox WHERE workspace_id=? AND version=1').all(workspace_id);
    assert.deepEqual(initial.map(x => x.client_id), ['app']);
    const update = (who, add, remove, auth) => w.api('POST', path + '/products', { actor_token: who.actor_token, add, remove }, auth);
    const other = basic('other');
    const otherOwner = await w.actor(creator.email, 'other');
    const otherAdmin = await w.actor(admin.email, 'other');
    const otherMember = await w.actor(workspaceAdmin.email, 'other');
    for (const [add, remove] of [[['tasks'], []], [[], ['tasks']], [['notes', 'tasks'], []], [['UPPER'], []]]) {
        assert.deepEqual(await response(await update(creator, add, remove), 400), {
            error: 'invalid_request', error_description: 'An app may only use its own product.'
        });
    }
    await error(await update(creator, ['notes'], ['notes']), 'invalid_request', 400);
    await error(await update(workspaceAdmin, ['notes'], []), 'access_denied', 403);
    await error(await update(creator, ['tasks'], [], other), 'invalid_request', 400);
    await error(await update(otherOwner, ['tasks'], [], other), 'not_found', 404);
    w.db.prepare("UPDATE clients SET workspace_admin='on' WHERE id='other'").run();
    await error(await update(otherMember, ['tasks'], [], other), 'not_found', 404);
    await error(await update(otherOwner, [], ['tasks'], other), 'not_found', 404);
    await error(await update(otherOwner, [], [], other), 'not_found', 404);
    await error(await w.api('GET', path, undefined, other), 'not_found', 404);

    const changed = await response(await update(otherOwner, ['tasks'], [], other));
    assert.deepEqual(changed.products, ['notes', 'tasks']);
    assert.equal(changed.version, 2);
    assert.deepEqual(await response(await w.api('GET', path, undefined, other)), changed);
    const rows = w.db.prepare('SELECT client_id,event,payload,user_id FROM workspace_event_outbox WHERE workspace_id=? AND version=2 ORDER BY client_id').all(workspace_id);
    assert.deepEqual(rows.map(r => r.client_id), ['app', 'notes-console', 'other', 'tasks-local']);
    for (const row of rows) {
        assert.equal(row.event, 'workspace-products-changed');
        assert.equal(row.user_id, null);
        assert.deepEqual(JSON.parse(row.payload), { workspace_id, version: 2, products: ['notes', 'tasks'] });
    }
    assert.deepEqual((await response(await update(otherOwner, [], ['tasks'], other))).products, ['notes']);
    const removed = w.db.prepare('SELECT client_id,payload FROM workspace_event_outbox WHERE workspace_id=? AND version=3 ORDER BY client_id').all(workspace_id);
    assert.deepEqual(removed.map(r => [r.client_id, JSON.parse(r.payload).products]),
        ['app', 'notes-console', 'other', 'tasks-local'].map(client => [client, ['notes']]));
    await error(await w.api('GET', path, undefined, other), 'not_found', 404);
    w.db.prepare('UPDATE users SET email_verified=0 WHERE id=?').run(admin.id);
    await error(await update(otherAdmin, ['tasks'], [], other), 'not_found', 404);
    // A verified realm admin with the app flag still cannot join a workspace in another realm.
    w.db.prepare("UPDATE clients SET workspace_admin='on' WHERE id='tasks-abroad'").run();
    w.db.prepare("INSERT INTO admins(realm_id,email,role,created) VALUES('second',?,'realm',0)").run(admin.email);
    const foreignEnv = await realmEnvForClient(w.env, 'tasks-abroad');
    const foreignAdmin = await ensureUser(foreignEnv, admin.email);
    const { session } = await issueSession(foreignEnv, foreignAdmin, 'email');
    const actor_token = await signIdToken(foreignEnv, session, { client_id: 'tasks-abroad', scope: 'openid' });
    // The host map was first loaded before the second realm existed.
    forgetRealms(w.env);
    const foreign = new Request(foreignEnv.ISSUER + path + '/products', { method: 'POST',
        headers: { authorization: basic('tasks-abroad'), 'content-type': 'application/json' },
        body: JSON.stringify({ add: ['tasks'], remove: [], actor_token }) });
    await error(await worker.fetch(foreign, w.env), 'not_found', 404);
    w.db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(admin.id);
    assert.deepEqual((await response(await update(otherAdmin, ['tasks'], [], other))).products, ['notes', 'tasks']);

    const closed = await w.team(creator);
    await response(await w.api('POST', root + '/' + closed.workspace_id + '/close', { actor_token: creator.actor_token }));
    await error(await w.api('POST', root + '/' + closed.workspace_id + '/products', {
        actor_token: otherOwner.actor_token, add: ['tasks'], remove: []
    }, other), 'not_found', 404);
});

test('joining a workspace rechecks ownership and the app flag in the write batch', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const { workspace_id } = await w.team(owner);
    w.addMember(workspace_id, await w.actor('co-owner@example.com'), 'owner');
    const path = root + '/' + workspace_id;
    const { actor_token } = await w.actor(owner.email, 'other');
    const join = () => w.api('POST', path + '/products', { add: ['tasks'], remove: [], actor_token }, basic('other'));
    w.db.prepare("UPDATE clients SET workspace_admin='on' WHERE id='other'").run();
    const batch = w.env.DB.batch.bind(w.env.DB);
    const disable = () => w.db.prepare("UPDATE clients SET workspace_admin='off' WHERE id='other'").run();
    const demote = () => w.db.prepare("UPDATE workspace_members SET role='admin' WHERE workspace_id=? AND user_id=?").run(workspace_id, owner.id);
    for (const change of [disable, demote]) {
        const intercepted = t.mock.method(w.env.DB, 'batch', statements => {
            change();
            return batch(statements);
        });
        await error(await join(), 'not_found', 404);
        intercepted.mock.restore();
        w.db.prepare("UPDATE clients SET workspace_admin='on' WHERE id='other'").run();
    }
    const workspace = await response(await w.api('GET', path));
    assert.deepEqual(workspace.products, ['notes']);
    assert.equal(workspace.version, 1);
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM workspace_event_outbox WHERE event='workspace-products-changed'").get().n, 0);
});

test('holds belong to each app, prevent close while present, and all writes reject a closed workspace', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com'), admin = await w.actor('member-admin@example.com');
    const { workspace_id } = await w.team(owner);
    await w.addTasks(owner, workspace_id);
    w.addMember(workspace_id, admin, 'admin');
    const path = root + '/' + workspace_id, holds = path + '/holds';
    const close = who => w.api('POST', path + '/close', { actor_token: who.actor_token });
    const hold = (reason, auth) => w.api('PUT', holds, { reason }, auth);
    await error(await hold(' '), 'invalid_request', 400);
    await error(await hold('x'.repeat(201)), 'invalid_request', 400);
    assert.equal((await response(await hold('Old reason'))).version, 3);
    assert.equal((await response(await hold('Open balance'))).version, 4);
    await error(await w.api('DELETE', holds, undefined, basic('other')), 'not_found', 404);
    assert.equal((await response(await hold('Incomplete export', basic('other')))).version, 5);
    await error(await close(admin), 'access_denied', 403);
    const blocked = await close(owner);
    const held = await blocked.clone().json();
    await error(blocked, 'workspace_held', 409);
    assert.match(held.error_description, /Open balance/);
    assert.match(held.error_description, /Incomplete export/);
    assert.ok(!held.error_description.includes('Old reason'));
    assert.equal((await response(await w.api('DELETE', holds))).version, 6);
    await error(await close(owner), 'workspace_held', 409);
    assert.equal((await response(await w.api('DELETE', holds, undefined, basic('other')))).version, 7);
    const closed = await response(await close(owner));
    assert.deepEqual(closed, { workspace_id, name: 'Team', kind: 'team', status: 'closed', products: ['notes', 'tasks'], version: 8 });
    const actor_token = owner.actor_token;
    const closedWrites = [
        ['PATCH', path, { name: 'Changed', actor_token }],
        ['POST', path + '/products', { add: ['notes'], remove: [], actor_token }],
        ['POST', path + '/invitations', { email: 'guest@example.com', role: 'member', actor_token }],
        ['DELETE', path + '/invitations/anything', { actor_token }],
        ['POST', path + '/members/' + admin.id, { role: 'viewer', actor_token }],
        ['DELETE', path + '/members/' + admin.id, { actor_token }],
        ['POST', path + '/close', { actor_token }],
        ['PUT', holds, { reason: 'New hold' }],
        ['DELETE', holds, undefined],
        ['PUT', path + '/resources', { resource: 'https://app.example/w/team' }],
        ['DELETE', path + '/resources', { resource: 'https://app.example/w/team' }]
    ];
    for (const args of closedWrites) await error(await w.api(...args), 'workspace_closed', 409);
    assert.deepEqual(await response(await w.api('GET', path)), closed);
    assert.equal((await response(await w.api('GET', path + '/members'))).members.length, 2);
    const events = w.db.prepare('SELECT event,payload FROM workspace_event_outbox WHERE workspace_id=? AND client_id=? ORDER BY version').all(workspace_id, 'app');
    assert.deepEqual(events.map(e => e.event), ['workspace-member-added', 'workspace-products-changed', ...Array(5).fill('workspace-updated'), 'workspace-closed']);
    assert.deepEqual(JSON.parse(events.at(-1).payload), { workspace_id, version: 8 });
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM audit WHERE target=?').get(workspace_id).n, 8);
    assert.equal(w.db.prepare("SELECT actor FROM audit WHERE target=? AND event='workspace-hold-put' ORDER BY id DESC LIMIT 1").get(workspace_id).actor, 'other');
});

test('resources must meet the app prefix and are unique globally; only the registering app can delete its mapping', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const { workspace_id } = await w.team(owner);
    await w.addTasks(owner, workspace_id);
    const second = await w.team(owner);
    const path = root + '/' + workspace_id + '/resources', resource = 'https://app.example/w/team';
    for (const foreign of ['https://another.example/w/team', 'https://app.example/work/team']) {
        await error(await w.api('PUT', path, { resource: foreign }), 'invalid_target', 403);
    }
    for (const unsafe of ['https://app.example/w%2Fteam', 'https://app.example/w/team?x=1', 'http://app.example/w/team']) {
        await error(await w.api('PUT', path, { resource: unsafe }), 'invalid_target', 400);
    }
    const count = table => w.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const outboxBefore = count('workspace_event_outbox'), auditBefore = count('audit');
    const outcomes = await Promise.all([w.api('PUT', path, { resource }), w.api('PUT', path, { resource })]);
    const [registered, raced] = await Promise.all(outcomes.map(r => response(r)));
    assert.equal(registered.version, 3);
    assert.deepEqual(raced, registered);
    assert.equal(count('workspace_resources'), 1);
    assert.equal(count('workspace_event_outbox'), outboxBefore + 2);
    assert.equal(count('audit'), auditBefore + 1);
    const changes = () => w.db.prepare('SELECT total_changes() AS n').get().n;
    const beforeRetry = changes();
    assert.deepEqual(await response(await w.api('PUT', path, { resource })), registered);
    assert.equal(changes(), beforeRetry);
    assert.equal(count('workspace_event_outbox'), outboxBefore + 2);
    assert.equal(count('audit'), auditBefore + 1);
    const secondPath = root + '/' + second.workspace_id + '/resources';
    const conflict = await response(await w.api('PUT', secondPath, { resource }), 409);
    assert.deepEqual(conflict, { error: 'resource_registered', error_description: 'Resource is already registered.' });
    assert.ok(!JSON.stringify(conflict).includes(workspace_id));
    await error(await w.api('DELETE', secondPath, { resource }), 'not_found', 404);
    await error(await w.api('DELETE', path, { resource }, basic('other')), 'invalid_target', 403);
    // Even if an operator later gives a second app the prefix, that app cannot unregister the first app's resource.
    w.db.prepare("UPDATE clients SET agent_resource_prefixes='[\"https://app.example/w/\"]' WHERE id='other'").run();
    const sameWorkspaceConflict = await response(await w.api('PUT', path, { resource }, basic('other')), 409);
    assert.deepEqual(sameWorkspaceConflict, conflict);
    assert.ok(!JSON.stringify(sameWorkspaceConflict).includes(workspace_id));
    await w.addTasks(owner, second.workspace_id);
    const otherWorkspaceConflict = await response(await w.api('PUT', secondPath, { resource }, basic('other')), 409);
    assert.deepEqual(otherWorkspaceConflict, conflict);
    await error(await w.api('DELETE', path, { resource }, basic('other')), 'not_found', 404);
    const realBatch = w.env.DB.batch.bind(w.env.DB);
    const appPrefix = w.db.prepare('UPDATE clients SET agent_resource_prefixes=? WHERE id=\'app\'');
    const intercepted = t.mock.method(w.env.DB, 'batch', async statements => {
        appPrefix.run('[]');
        return realBatch(statements);
    });
    for (const method of ['PUT', 'DELETE']) {
        appPrefix.run('["https://app.example/w/"]');
        await error(await w.api(method, path, { resource }), 'access_denied', 403);
    }
    intercepted.mock.restore();
    assert.deepEqual({ ...w.db.prepare('SELECT workspace_id,client_id FROM workspace_resources WHERE resource=?').get(resource) }, { workspace_id, client_id: 'app' });
    appPrefix.run('["https://app.example/w/"]');
    assert.equal((await response(await w.api('DELETE', path, { resource }))).version, 4);
    await error(await w.api('DELETE', path, { resource }), 'not_found', 404);
    assert.equal((await response(await w.api('PUT', secondPath, { resource }))).version, 3);
    const renamed = await response(await w.api('PATCH', root + '/' + second.workspace_id, { name: 'Renamed', actor_token: owner.actor_token }));
    assert.deepEqual(await response(await w.api('PUT', secondPath, { resource })), renamed);
    await response(await w.api('POST', root + '/' + second.workspace_id + '/close', { actor_token: owner.actor_token }));
    await error(await w.api('PUT', secondPath, { resource }), 'workspace_closed', 409);
});

test('closing cannot race a hold or a roster change past the transaction guard', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com'), member = await w.actor('member@example.com');
    const { workspace_id } = await w.team(owner);
    const path = root + '/' + workspace_id;
    const close = () => w.api('POST', path + '/close', { actor_token: owner.actor_token });
    const batch = w.env.DB.batch.bind(w.env.DB);
    let race = () => w.addMember(workspace_id, member, 'viewer');
    const intercepted = t.mock.method(w.env.DB, 'batch', statements => {
        race();
        return batch(statements);
    });
    await error(await close(), 'conflict', 409);
    race = () => w.db.prepare('INSERT INTO workspace_holds(workspace_id,client_id,reason,created) VALUES(?,?,?,?)')
        .run(workspace_id, 'app', 'A competing hold', Date.now());
    await error(await close(), 'workspace_held', 409);
    intercepted.mock.restore();
    assert.equal((await response(await w.api('GET', path))).version, 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox WHERE workspace_id=?').get(workspace_id).n, 1);
    await response(await w.api('DELETE', path + '/holds'));
    assert.equal((await response(await close())).status, 'closed');
});
