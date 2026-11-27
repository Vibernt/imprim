import test from 'node:test';
import assert from 'node:assert/strict';
import { response } from './support/workspaces.mjs';
import { checkBoundaries, csrf, problem } from './support/account-api.mjs';
import { seedAccountWorkspace, seedAccountWorkspaceMember } from './support/account-workspaces.mjs';
import { base, fixture, invite, ownerEmail, team } from './support/account-workspace-api.mjs';
import { basic } from './support/world.mjs';
import { limiterFor } from '../apps/server/src/worker.mjs';

test('account workspace list, app links and the 50-member record page use realm and admission boundaries', async t => {
    const w = await fixture(t), { db, owner, member } = w;
    seedAccountWorkspace(db, 'personal', 'My notes', { kind: 'personal', owner: owner.user.id, products: ['notes'] });
    seedAccountWorkspace(db, 'closed', 'Closed', { status: 'closed', owner: owner.user.id });
    db.exec(`UPDATE clients SET listed=0,branding='{"name":"Task Board"}' WHERE id='other';
        UPDATE clients SET branding='{"name":"Shared Notes"}' WHERE id='app';`);
    const admit = db.prepare("INSERT INTO client_admissions(user_id,client_id,created,source,last_signed_in) VALUES(?,?,0,?,?)");
    admit.run(owner.user.id, 'other', 'app', 1);
    admit.run(member.user.id, 'other', 'workspace', 2);
    const notes = { product: 'notes', apps: [{ id: 'app', name: 'Shared Notes', initiate_login_uri: 'https://app.example.com/start' }] };
    const tasks = { product: 'tasks', apps: [{ id: 'other', name: 'Task Board', initiate_login_uri: 'https://tasks.example.com/start' }] };
    assert.deepEqual(await response(await w.get()), { workspaces: [
        { workspace_id: 'team', name: 'Alpha team', kind: 'team', members: 4, role: 'owner', products: [notes, tasks] },
        { workspace_id: 'personal', name: 'My notes', kind: 'personal', members: 1, role: 'owner', products: [notes] }
    ] });
    assert.deepEqual((await response(await w.get(base, member))).workspaces[0].products, [notes, tasks]);
    assert.deepEqual((await response(await w.get(base, w.viewer))).workspaces[0].products[1].apps[0],
        { ...tasks.apps[0], initiate_login_uri: null });
    db.exec("UPDATE clients SET listed=0 WHERE id='app'");
    const person = (await response(await w.get(base, member))).workspaces[0];
    assert.equal(person.products[0].apps[0].initiate_login_uri, null, 'membership alone does not publish an unlisted URL');
    await problem(await w.get(base, w.stranger), 404, 'not_found');

    const now = db.prepare('SELECT max(created) AS created FROM workspace_members').get().created + 1;
    const add = db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,?)');
    for (let index = 0; index < 50; index++) {
        const id = 'roster-' + index;
        add.run(id, id + '@example.com', now);
        seedAccountWorkspaceMember(db, 'team', id, 'viewer', now);
    }
    const { invitation_id } = await response(await w.post('invitations', invite), 201);
    db.prepare(`INSERT INTO workspace_invitations(id,workspace_id,email,role,created,expires_at)
        VALUES('expired','team','expired@example.com','member',?,?)`).run(now, Date.now() - 1);
    const first = await response(await w.get(team));
    assert.equal(first.role, 'owner');
    assert.deepEqual(first.workspace, { workspace_id: 'team', name: 'Alpha team', kind: 'team', members: 54,
        version: 2, owner_count: 1, products: [{ ...notes, apps: [{ ...notes.apps[0], initiate_login_uri: null }] }, tasks] });
    assert.deepEqual(first.invitations.map(({ invitation_id, email, role }) => ({ invitation_id, email, role })), [{ invitation_id, ...invite }]);
    assert.deepEqual(first.members.rows.find(row => row.sub === owner.user.id), {
        sub: owner.user.id, email: ownerEmail, role: 'owner',
        created: db.prepare('SELECT created FROM workspace_members WHERE workspace_id=? AND user_id=?').get('team', owner.user.id).created
    });
    assert.equal(first.members.rows.length, 50);
    assert.ok(first.members.after);
    const second = await response(await w.get(team + '?after=' + first.members.after, member));
    assert.equal(second.members.rows.length, 4);
    assert.equal(second.members.after, null);
    assert.equal(new Set([...first.members.rows, ...second.members.rows].map(row => row.sub)).size, 54);
    assert.equal(Object.hasOwn(second, 'invitations'), false);
    assert.equal((await response(await w.get(team, w.admin))).invitations.length, 1);
    assert.deepEqual((await response(await w.get(base + '/personal'))).members.rows.map(row => row.role), ['owner']);
    await problem(await w.get(team + '?after=invalid'), 400, 'invalid_request');
    await problem(await w.get(team + '?after=a&after=b'), 400, 'invalid_request');
});

test('all account workspace routes use session, CSRF, Origin and rate limiting', async t => {
    const w = await fixture(t);
    const mutations = ['invitations', 'invitations/open/revoke', 'members/member/role', 'members/member/remove', 'leave', 'rename'];
    await checkBoundaries({ ...w, post: w.rawPost }, w.owner.cookie, [base, team], mutations.map(action => team + '/' + action));
    await problem(await w.call('/v1/account/' + team + '/rename', { method: 'POST', headers: {
        cookie: w.owner.cookie, 'x-csrf-token': csrf(w.owner.cookie), 'content-type': 'application/json'
    }, body: JSON.stringify({ name: 'Refused' }) }), 403, 'origin');
    await problem(await w.call('/v1/account/' + team, { headers: { authorization: basic() } }), 401, 'login_required');
    await problem(await w.post('rename', { name: 'Refused' }, w.owner, team, { 'x-csrf-token': csrf(w.member.cookie),
        cookie: w.owner.cookie.replace(csrf(w.owner.cookie), csrf(w.member.cookie)) }), 403, 'csrf');
    assert.equal(limiterFor('GET', '/v1/account/' + base), 'API_LIMITER');
    for (const action of mutations) assert.equal(limiterFor('POST', '/v1/account/' + team + '/' + action), 'API_LIMITER');
    w.env.API_LIMITER.limit = async () => ({ success: false });
    await problem(await w.get(), 429, 'rate_limit');
    await problem(await w.post('rename', { name: 'Refused' }), 429, 'rate_limit');
    assert.equal(w.version(), 1);
});

test('members and viewers cannot manage, and workspace admins cannot manage ownership or rename', async t => {
    const w = await fixture(t);
    const { invitation_id } = await response(await w.post('invitations', invite), 201);
    const member = 'members/' + w.member.user.id, owner = 'members/' + w.owner.user.id;
    for (const who of [w.member, w.viewer]) {
        for (const [action, body] of [
            ['invitations', invite], ['invitations/' + invitation_id + '/revoke', {}],
            [member + '/role', { role: 'viewer' }], [member + '/remove', {}], ['rename', { name: 'Refused' }]
        ]) await problem(await w.post(action, body, who), 403, 'access_denied');
    }
    for (const [action, body] of [
        ['invitations', { ...invite, role: 'owner' }], [member + '/role', { role: 'owner' }],
        [owner + '/role', { role: 'viewer' }], [owner + '/remove', {}], ['rename', { name: 'Refused' }]
    ]) await problem(await w.post(action, body, w.admin), 403, 'access_denied');
    for (const action of [owner + '/remove', owner + '/role', 'leave']) {
        const refusal = await response(await w.post(action, { role: 'admin' }), 409);
        assert.equal(refusal.error, 'last_owner');
        if (action === 'leave') assert.equal(refusal.error_description, 'Make someone else an owner first.');
    }
    for (const role of ['root', 'Owner', null, 0])
        for (const [action, body] of [['invitations', { ...invite, role }], [member + '/role', { role }]])
            await problem(await w.post(action, body), 400, 'invalid_request');
    for (const name of ['', '\0', 'a'.repeat(121)])
        await problem(await w.post('rename', { name }), 400, 'invalid_request');
    await problem(await w.post('members/%ZZ/role', { role: 'admin' }), 400, 'invalid_request');
    assert.equal(w.version(), 2);
    await response(await w.post(member + '/role', { role: 'owner' }));
    assert.deepEqual(await response(await w.post('leave')), { workspaces_available: false });
    assert.equal((await response(await w.get(team, w.member))).role, 'owner');
});

test('closed, foreign-realm and unjoined workspaces are indistinguishable from missing workspaces', async t => {
    const w = await fixture(t), { db, owner, stranger } = w;
    seedAccountWorkspace(db, 'private-team', 'Private', { owner: stranger.user.id });
    seedAccountWorkspace(db, 'closed', 'Closed', { status: 'closed', owner: owner.user.id });
    db.prepare('INSERT INTO realms(id,issuer,display_name,created) VALUES(?,?,?,0)').run('foreign', 'https://id.other.example.com', 'Foreign');
    seedAccountWorkspace(db, 'foreign', 'Foreign', { realm: 'foreign', owner: owner.user.id });
    const { invitation_id } = await response(await w.post('invitations', invite, stranger, base + '/private-team'), 201);
    await problem(await w.post('invitations/' + invitation_id + '/revoke'), 404, 'not_found');
    await problem(await w.post('invitations/' + invitation_id + '/revoke', {}, stranger), 404, 'not_found');

    const expected = { error: 'not_found', error_description: 'Workspace not found.' };
    for (const [id, who] of [['missing', owner], ['closed', owner], ['foreign', owner], ['private-team', owner], ['team', stranger]]) {
        const path = base + '/' + id;
        assert.deepEqual(await response(await w.get(path, who), 404), expected);
        assert.deepEqual(await response(await w.post('rename', { name: 'Refused' }, who, path), 404), expected);
    }
    seedAccountWorkspace(db, 'personal', 'My notes', { kind: 'personal', owner: owner.user.id });
    await problem(await w.post('invitations', invite, owner, base + '/personal'), 409, 'personal_workspace');
    await problem(await w.post('leave', {}, owner, base + '/personal'), 409, 'last_owner');
    db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','off') WHERE id='default'");
    assert.deepEqual(await response(await w.get(), 404), expected);
    assert.deepEqual(await response(await w.get(team), 404), expected);
    assert.deepEqual(await response(await w.post('rename', { name: 'Refused' }), 404), expected);
    assert.equal(w.version(), 1);
});

test('account workspace operations refuse dead sessions and blocked or merged uses of a session', async t => {
    const w = await fixture(t), { db, owner, member, admin, viewer } = w;
    db.prepare('UPDATE sessions SET expires_at=0 WHERE sid=?').run(owner.session.sid);
    db.prepare('DELETE FROM sessions WHERE sid=?').run(admin.session.sid);
    db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(member.user.id);
    db.prepare('UPDATE users SET merged_into=? WHERE id=?').run(owner.user.id, viewer.user.id);
    for (const who of [owner, member, admin, viewer]) {
        await problem(await w.get(team, who), 401, 'login_required');
        await problem(await w.post('rename', { name: 'Refused' }, who), 401, 'login_required');
    }
    assert.equal(w.version(), 1);
});
