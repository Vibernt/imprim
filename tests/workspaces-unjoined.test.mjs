import test from 'node:test';
import assert from 'node:assert/strict';
import { getClient } from '../apps/server/src/oidc/clients.mjs';
import { admitSession } from '../apps/server/src/services/admission.mjs';
import { error } from './support/agents.mjs';
import { basic } from './support/world.mjs';
import { response, root, setup } from './support/workspaces.mjs';

const ownerEmail = 'owner@example.com';

async function unjoinedTeam(t) {
    const w = await setup(t);
    const operator = await w.actor('operator@example.com');
    const { workspace_id } = await w.team(operator, { first_owner_email: ownerEmail });
    const path = root + '/' + workspace_id;
    const invitationsPath = path + '/invitations';
    const { invitations: [first] } = await response(await w.api('GET', invitationsPath));
    await w.drain();
    const invite = (role = 'owner', actor_token = operator.actor_token, auth) =>
        w.api('POST', invitationsPath, { email: ownerEmail, role, actor_token }, auth);
    const revoke = (id = first.invitation_id, actor_token = operator.actor_token, auth) =>
        w.api('DELETE', invitationsPath + '/' + id, { actor_token }, auth);
    const close = (actor_token = operator.actor_token, auth) => w.api('POST', path + '/close', { actor_token }, auth);
    const audit = () => w.db.prepare('SELECT event,actor,detail FROM audit WHERE target=? ORDER BY id').all(workspace_id)
        .map(({ event, actor, detail }) => ({ event, actor, detail: JSON.parse(detail) }));
    const events = () => w.db.prepare('SELECT event,client_id,user_id,version,payload FROM workspace_event_outbox WHERE workspace_id=? ORDER BY version')
        .all(workspace_id).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    return { ...w, operator, workspace_id, path, invitationsPath, first, invite, revoke, close, audit, events };
}

test('a nonmember operator resends an owner invitation, revokes it, and closes an unjoined team', async t => {
    const w = await unjoinedTeam(t);
    const { workspace_id, operator, first } = w;
    assert.deepEqual(await response(await w.api('GET', w.path + '/members')), { members: [], version: 1, next_cursor: null });
    assert.deepEqual(w.mails.map(mail => mail.to), [ownerEmail]);

    const resent = await response(await w.invite(), 201);
    assert.notEqual(resent.invitation_id, first.invitation_id);
    assert.deepEqual(await response(await w.api('GET', w.invitationsPath)), {
        invitations: [{ ...resent, email: ownerEmail, role: 'owner' }]
    });
    assert.ok(w.db.prepare('SELECT revoked_at FROM workspace_invitations WHERE id=?').get(first.invitation_id).revoked_at);
    await w.drain();
    assert.deepEqual(w.mails.map(mail => mail.to), [ownerEmail, ownerEmail]);
    await error(await w.revoke(), 'not_found', 404);
    assert.equal((await response(await w.revoke(resent.invitation_id))).version, 3);
    assert.deepEqual(await response(await w.api('GET', w.invitationsPath)), { invitations: [] });
    assert.deepEqual(await response(await w.close()), { workspace_id, name: 'Team', kind: 'team', status: 'closed', products: ['notes'], version: 4 });

    assert.deepEqual(w.events(), [1, 2, 3, 4].map(version => ({
        event: version === 4 ? 'workspace-closed' : 'workspace-updated', client_id: 'app', user_id: null, version,
        payload: version === 4 ? { workspace_id, version } : { workspace_id, version, name: 'Team' }
    })));
    const invitation_id = resent.invitation_id;
    assert.deepEqual(w.audit().slice(1), [
        ['workspace-invited', { invitation_id, role: 'owner' }],
        ['workspace-invitation-revoked', { invitation_id }],
        ['workspace-closed', {}]
    ].map(([event, fields], i) => ({
        event, actor: operator.id, detail: { ...fields, client_id: 'app', unjoined: true, version: i + 2 }
    })));
    assert.equal(w.audit().length, 4);
});

test('unjoined writes require the app flag, its product, and a live actor token; invitations can only grant owner', async t => {
    const w = await unjoinedTeam(t);
    const calls = (token, auth) => [() => w.invite('owner', token, auth), () => w.revoke(w.first.invitation_id, token, auth), () => w.close(token, auth)];
    for (const role of ['admin', 'member', 'viewer']) await error(await w.invite(role), 'access_denied', 403);
    await error(await w.api('PATCH', w.path, { name: 'Renamed', actor_token: w.operator.actor_token }), 'access_denied', 403);
    for (const call of calls(null)) await error(await call(), 'invalid_request', 400);

    const other = await w.actor(w.operator.email, 'other');
    const auth = basic('other');
    w.db.exec("UPDATE clients SET workspace_admin='on' WHERE id='other'");
    await error(await w.api('GET', w.path, undefined, auth), 'not_found', 404);
    for (const call of calls(other.actor_token, auth)) await error(await call(), 'not_found', 404);
    w.db.exec("UPDATE clients SET product='notes',workspace_admin='off' WHERE id='other'");
    for (const call of calls(other.actor_token, auth)) await error(await call(), 'access_denied', 403);

    const batch = w.env.DB.batch.bind(w.env.DB);
    const intercepted = t.mock.method(w.env.DB, 'batch', statements => {
        w.db.exec("UPDATE clients SET workspace_admin='off' WHERE id='app'");
        return batch(statements);
    });
    for (const call of calls(w.operator.actor_token)) {
        w.db.exec("UPDATE clients SET workspace_admin='on' WHERE id='app'");
        await error(await call(), 'access_denied', 403);
    }
    intercepted.mock.restore();
    w.db.exec("UPDATE clients SET workspace_admin='on' WHERE id='app'");
    w.db.prepare('DELETE FROM sessions WHERE sid=?').run(w.operator.session.sid);
    for (const call of calls(w.operator.actor_token)) await error(await call(), 'invalid_request', 400);
    await w.drain();
    assert.equal(w.mails.length, 1);
    assert.equal(w.audit().length, 1);
    assert.equal(w.events().length, 1);
    assert.deepEqual(await response(await w.api('GET', w.invitationsPath)), { invitations: [w.first] });
});

test('the first owner joining ends the app rule and leaves normal owner permissions in force', async t => {
    const w = await unjoinedTeam(t);
    const owner = await w.actor(ownerEmail);
    await admitSession(w.env, await getClient(w.env, 'app'), owner.session);
    assert.deepEqual(await response(await w.api('GET', w.path + '/members')), {
        members: [{ sub: owner.id, email: ownerEmail, role: 'owner' }], version: 2, next_cursor: null
    });
    await error(await w.invite(), 'access_denied', 403);
    const next = await response(await w.api('POST', w.invitationsPath, {
        email: 'another-owner@example.com', role: 'owner', actor_token: owner.actor_token
    }), 201);
    await error(await w.revoke(next.invitation_id), 'access_denied', 403);
    await error(await w.close(), 'access_denied', 403);
    await w.drain();
    assert.equal((await response(await w.revoke(next.invitation_id, owner.actor_token))).version, 4);
    assert.equal((await response(await w.close(owner.actor_token))).version, 5);
    assert.equal(w.audit().length, 5);
    assert.ok(w.audit().every(({ detail }) => !Object.hasOwn(detail, 'unjoined')));
});

test('any membership row disables the unjoined app rule', async t => {
    const w = await unjoinedTeam(t);
    w.addMember(w.workspace_id, await w.actor('viewer@example.com'), 'viewer');
    await error(await w.invite(), 'access_denied', 403);
    await error(await w.revoke(), 'access_denied', 403);
    await error(await w.close(), 'access_denied', 403);
    assert.equal(w.audit().length, 1);
    assert.equal(w.events().length, 1);
});

test('the app rule excludes personal workspaces and cannot close a team with a hold', async t => {
    const w = await unjoinedTeam(t);
    const owner = await w.actor(ownerEmail);
    const personal = await response(await w.api('POST', root, { kind: 'personal', name: 'Personal', actor_token: owner.actor_token }), 201);
    const personalPath = root + '/' + personal.workspace_id;
    const { actor_token } = w.operator;
    await error(await w.api('POST', personalPath + '/invitations', { email: ownerEmail, role: 'owner', actor_token }), 'access_denied', 403);
    await error(await w.api('DELETE', personalPath + '/invitations/' + w.first.invitation_id, { actor_token }), 'access_denied', 403);
    await error(await w.api('POST', personalPath + '/close', { actor_token }), 'access_denied', 403);

    await response(await w.api('PUT', w.path + '/holds', { reason: 'Incomplete export' }));
    const held = await response(await w.close(), 409);
    assert.equal(held.error, 'workspace_held');
    assert.match(held.error_description, /Incomplete export/);
    assert.equal((await response(await w.api('GET', w.path))).version, 2);
    assert.equal(w.audit().length, 2);
    assert.equal(w.events().length, 2);
    await response(await w.api('DELETE', w.path + '/holds'));
    assert.equal((await response(await w.close())).status, 'closed');
});

for (const winner of ['accept', 'close']) test(`unjoined close vs owner acceptance: ${winner} commits first`, async t => {
    const w = await unjoinedTeam(t);
    const owner = await w.actor(ownerEmail), client = await getClient(w.env, 'app');
    const accept = () => admitSession(w.env, client, owner.session);
    const batch = w.env.DB.batch.bind(w.env.DB);
    // Pause the losing write at its batch boundary and let the competing write commit.
    const intercepted = t.mock.method(w.env.DB, 'batch', async statements => {
        intercepted.mock.restore();
        if (winner === 'accept') await accept();
        else assert.equal((await response(await w.close())).status, 'closed');
        return batch(statements);
    });
    if (winner === 'accept') await error(await w.close(), 'access_denied', 403);
    else await assert.rejects(accept(), { code: 'conflict', status: 409 });

    const joined = winner === 'accept';
    assert.equal((await response(await w.api('GET', w.path))).status, joined ? 'active' : 'closed');
    assert.deepEqual(await response(await w.api('GET', w.path + '/members')), {
        members: joined ? [{ sub: owner.id, email: ownerEmail, role: 'owner' }] : [], version: 2, next_cursor: null
    });
    assert.equal(w.db.prepare('SELECT accepted_by FROM workspace_invitations WHERE id=?').get(w.first.invitation_id).accepted_by,
        joined ? owner.id : null);
    const event = joined ? 'workspace-member-added' : 'workspace-closed';
    assert.deepEqual(w.events().map(row => row.event), ['workspace-updated', event]);
    assert.deepEqual(w.audit().map(row => row.event), ['workspace-created', event]);
});
