import test from 'node:test';
import assert from 'node:assert/strict';
import { response } from './support/workspaces.mjs';
import { accountSession, problem } from './support/account-api.mjs';
import { seedAccountWorkspaceMember } from './support/account-workspaces.mjs';
import { fixture, invite, team } from './support/account-workspace-api.mjs';
import { getClient } from '../apps/server/src/oidc/clients.mjs';
import { admitSession } from '../apps/server/src/services/admission.mjs';

test('account workspace writes share versioning, access teardown, audits and event recipients', async t => {
    const w = await fixture(t), { db, member, viewer, owner } = w;
    const admission = db.prepare('INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,?,0,?)');
    const appSession = db.prepare('INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES(?,?,?,?)');
    const now = Date.now();
    for (const person of [member, viewer]) {
        admission.run(person.user.id, 'app', 'workspace');
        admission.run(person.user.id, 'other', 'app');
        appSession.run('app', person.user.id, person.session.sid, now);
        appSession.run('other', person.user.id, person.session.sid, now);
        db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,
            created,last_used,expires_at,workspace_id) VALUES(?, 'agent', 'Notes agent', 'metadata', 'app', ?,
            'https://app.example.com/w/team/mcp', 'read', 'authorization_code', ?, ?, ?, 'team')`)
            .run(person.user.id, person.user.id, now, now, now + 60000);
    }
    const { invitation_id: first } = await response(await w.post('invitations', invite, w.admin), 201);
    const { invitation_id: resent } = await response(await w.post('invitations', invite), 201);
    assert.notEqual(first, resent);
    assert.equal(w.mails.at(-1).to, invite.email);
    const stored = db.prepare('SELECT invited_by,via_client,revoked_at FROM workspace_invitations WHERE id=?');
    assert.ok(stored.get(first).revoked_at);
    assert.deepEqual({ ...stored.get(resent) }, { invited_by: owner.user.id, via_client: null, revoked_at: null });
    await response(await w.post('invitations/' + resent + '/revoke', {}, w.admin));
    assert.ok(stored.get(resent).revoked_at);
    await problem(await w.post('invitations/' + resent + '/revoke'), 404, 'not_found');
    await response(await w.post('members/' + member.user.id + '/role', { role: 'viewer' }, w.admin));
    assert.equal(w.roster().find(row => row.user_id === member.user.id).role, 'viewer');
    await response(await w.post('members/' + member.user.id + '/remove', {}, w.admin));
    assert.deepEqual(await response(await w.post('leave', {}, viewer)), { workspaces_available: false });
    await response(await w.post('rename', { name: '  Updated team  ' }));
    assert.equal((await response(await w.get(team))).workspace.name, 'Updated team');
    const events = ['workspace-updated', 'workspace-updated', 'workspace-updated', 'workspace-role-changed',
        'workspace-member-removed', 'workspace-member-removed', 'workspace-updated'];
    for (const [index, event] of events.entries()) {
        const version = index + 2;
        const rows = db.prepare('SELECT client_id,event,payload FROM workspace_event_outbox WHERE workspace_id=? AND version=? ORDER BY client_id').all('team', version);
        assert.deepEqual(rows.map(row => [row.client_id, row.event, JSON.parse(row.payload).version]), [['app', event, version], ['other', event, version]]);
    }
    const audit = db.prepare('SELECT event,actor,detail FROM audit WHERE target=? ORDER BY id').all('team');
    assert.deepEqual(audit.map(row => row.event), ['workspace-invited', 'workspace-invited', 'workspace-invitation-revoked', ...events.slice(3)]);
    assert.deepEqual(audit.map(row => row.actor), [w.admin, owner, w.admin, w.admin, w.admin, viewer, owner].map(person => person.user.id));
    for (const [index, row] of audit.entries()) {
        const detail = JSON.parse(row.detail);
        assert.equal(detail.source, 'account');
        assert.equal(detail.version, index + 2);
        assert.equal(Object.hasOwn(detail, 'client_id'), false);
        assert.doesNotMatch(row.detail, /@example\.com/);
    }
    assert.equal(w.version(), 8);
    for (const person of [member, viewer]) {
        assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get(person.user.id));
        assert.ok(db.prepare('SELECT 1 FROM sessions WHERE sid=?').get(person.session.sid));
        assert.deepEqual(db.prepare('SELECT client_id FROM client_admissions WHERE user_id=?').all(person.user.id).map(row => row.client_id), ['other']);
        assert.deepEqual(db.prepare('SELECT client_id FROM app_sessions WHERE user_id=?').all(person.user.id), []);
        assert.deepEqual(db.prepare('SELECT client_id FROM logout_outbox WHERE user_id=? ORDER BY client_id').all(person.user.id)
            .map(row => row.client_id), ['app', 'other']);
        assert.ok(db.prepare('SELECT revoked_at FROM agent_grants WHERE id=?').get(person.user.id).revoked_at);
        assert.ok(db.prepare('SELECT 1 FROM agent_revocation_outbox WHERE user_id=?').get(person.user.id));
        await problem(await w.get(team, person), 404, 'not_found');
    }
});

test('guarded workspace writes recheck the session, membership and address inside the batch', async t => {
    const w = await fixture(t), { db, owner } = w;
    let beforeBatch;
    const batch = w.env.DB.batch.bind(w.env.DB);
    t.mock.method(w.env.DB, 'batch', async statements => {
        beforeBatch();
        return batch(statements);
    });
    const rename = () => w.post('rename', { name: 'Refused' });
    beforeBatch = () => db.prepare('UPDATE sessions SET expires_at=0 WHERE sid=?').run(owner.session.sid);
    await problem(await rename(), 401, 'login_required');
    db.prepare('UPDATE sessions SET expires_at=? WHERE sid=?').run(Date.now() + 600_000, owner.session.sid);
    beforeBatch = () => db.prepare("UPDATE workspace_members SET role='admin' WHERE workspace_id=? AND user_id=?").run('team', owner.user.id);
    await problem(await rename(), 403, 'access_denied');
    db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND user_id=?").run('team', owner.user.id);
    beforeBatch = () => db.exec('UPDATE clients SET initiate_login_uri=NULL');
    await problem(await w.post('invitations', invite), 409, 'no_sign_in_address');
    beforeBatch = () => db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run('team', owner.user.id);
    await problem(await rename(), 404, 'not_found');
    assert.equal(w.version(), 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit WHERE target=?').get('team').n, 0);
});

test('account re-invite refuses a missing app address without revoking an open invitation', async t => {
    const w = await fixture(t), { db } = w;
    const { invitation_id } = await response(await w.post('invitations', invite), 201);
    db.prepare('UPDATE clients SET initiate_login_uri=?').run(w.env.ISSUER + '/login/?next=%2Fadmin');
    const refusal = await response(await w.post('invitations', invite), 409);
    assert.deepEqual(refusal, { error: 'no_sign_in_address',
        error_description: 'No app in this workspace has a sign-in address yet. Ask your administrator.' });
    assert.equal(w.version(), 2);
    assert.equal(w.mails.length, 1);
    assert.deepEqual(db.prepare('SELECT id,revoked_at FROM workspace_invitations').all().map(row => [row.id, row.revoked_at]),
        [[invitation_id, null]]);
});

test('account invitations require the app admission proof and can be accepted only once', async t => {
    const w = await fixture(t), { db } = w;
    db.exec("UPDATE clients SET signup_policy='invited'");
    const { invitation_id } = await response(await w.post('invitations', invite), 201);
    const client = await getClient(w.env, 'app'), recipient = await accountSession(w, invite.email);
    await assert.rejects(admitSession(w.env, client, { ...recipient.session, method: 'oidc' }), { code: 'access_denied' });
    await problem(await w.get(team, recipient), 404, 'not_found');
    assert.equal(db.prepare('SELECT accepted_at FROM workspace_invitations WHERE id=?').get(invitation_id).accepted_at, null);
    await admitSession(w.env, client, recipient.session);
    await admitSession(w.env, client, recipient.session);
    assert.equal((await response(await w.get(team, recipient))).role, 'member');
    assert.equal(db.prepare('SELECT accepted_by FROM workspace_invitations WHERE id=?').get(invitation_id).accepted_by, recipient.user.id);
    assert.equal(w.roster().filter(row => row.user_id === recipient.user.id).length, 1);
    assert.equal(w.version(), 3);
});

test('member writes preserve imported subjects through path encoding', async t => {
    const w = await fixture(t);
    const users = w.db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,0)');
    for (const [index, [sub, segment]] of [
        ['.', ':dot'], ['..', ':dotdot'], [':dot', '%3Adot'], ['imported/user?#', 'imported%2Fuser%3F%23']
    ].entries()) {
        users.run(sub, 'imported-' + index + '@example.com');
        seedAccountWorkspaceMember(w.db, 'team', sub);
        await response(await w.post('members/' + segment + '/role', { role: 'viewer' }));
        assert.equal(w.roster().find(row => row.user_id === sub).role, 'viewer');
    }
    await response(await w.post('members/:dotdot/remove'));
    assert.equal(w.roster().some(row => row.user_id === '..'), false);
    assert.equal(w.roster().some(row => row.user_id === '.'), true);
});
