import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { admitSession, ensureUser } from '../apps/server/src/services/admission.mjs';
import { getClient } from '../apps/server/src/oidc/clients.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { providerIdentity } from '../apps/server/src/auth/provider-identity.mjs';
import { accessEndStatements } from '../apps/server/src/workspaces/teardown.mjs';

const email = 'person@example.com';
async function setup(t) {
    const w = await world(t, 'invited'), db = w.env.DB.db;
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
        UPDATE clients SET workspaces='shared',product='notes',backchannel_uri='https://app.example/events' WHERE id='app';`);
    return { ...w, db, client: await getClient(w.env, 'app') };
}
function workspace(db, id) {
    db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,version,created) VALUES(?,'default','team',?,4,0)").run(id, id);
    db.prepare("INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,'notes',0)").run(id);
}
function joinedWorkspace(db, userId) {
    workspace(db, 'joined');
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('joined',?,'member',0,0)").run(userId);
}
function invite(db, id, role = 'member') {
    db.prepare('INSERT INTO workspace_invitations(id,workspace_id,email,role,created,expires_at) VALUES(?,?,?,?,0,?)')
        .run(`invite-${id}`, id, email, role, Date.now() + 60_000);
}
const source = db => db.prepare("SELECT source FROM client_admissions WHERE client_id='app'").get()?.source;
const providerSignIn = (w, profile = {}) => providerIdentity(w.env, w.client, 'upstream', {
    providerId: 'upstream-subject', email, verified: true, ...profile
});
const leave = (w, userId) => w.env.DB.batch([
    ...accessEndStatements(w.env, 'joined', userId),
    w.env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id='joined' AND user_id=?").bind(userId)
]);

test('provider sign-in records workspace membership and teardown removes the admission', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    joinedWorkspace(w.db, user.id);
    const profile = { authoritative: true };
    assert.equal((await providerSignIn(w, profile)).id, user.id);
    assert.equal(source(w.db), 'workspace');
    const { session } = await issueSession(w.env, user, 'upstream');
    await admitSession(w.env, w.client, session);
    await leave(w, user.id);
    assert.equal(source(w.db), undefined);
    await assert.rejects(admitSession(w.env, w.client, session), { code: 'access_denied', status: 403 });
    await assert.rejects(providerSignIn(w, profile), { code: 'access_denied', status: 403, message: 'Account unavailable.' });
});

for (const policy of ['open', 'invitation', 'domain']) test(`provider sign-in records app policy (${policy}) even for a workspace member`, async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    joinedWorkspace(w.db, user.id);
    if (policy === 'open') w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    if (policy === 'invitation') w.db.prepare("INSERT INTO invitations(client_id,email,expires_at) VALUES('app',?,?)").run(email, Date.now() + 60_000);
    if (policy === 'domain') w.db.exec(`UPDATE clients SET allowed_domains='["example.com"]' WHERE id='app'`);
    w.client = await getClient(w.env, 'app');
    await providerSignIn(w, { authoritative: true });
    assert.equal(source(w.db), 'app');
    await leave(w, user.id);
    assert.equal(source(w.db), 'app');
    await admitSession(w.env, w.client, (await issueSession(w.env, user, 'upstream')).session);
});

test('provider proof accepts workspace invitations before the registry session completes', async t => {
    const w = await setup(t);
    workspace(w.db, 'alpha'); invite(w.db, 'alpha', 'viewer');
    workspace(w.db, 'beta'); invite(w.db, 'beta', 'admin');
    const user = await providerSignIn(w);
    assert.equal(source(w.db), 'workspace');
    assert.deepEqual(w.db.prepare('SELECT workspace_id,user_id,role FROM workspace_members ORDER BY workspace_id').all().map(Object.values),
        [['alpha', user.id, 'viewer'], ['beta', user.id, 'admin']]);
    for (const invitation of w.db.prepare('SELECT accepted_at,accepted_by FROM workspace_invitations').all()) {
        assert.ok(invitation.accepted_at > 0);
        assert.equal(invitation.accepted_by, user.id);
    }
    assert.deepEqual(w.db.prepare('SELECT version,event FROM workspace_event_outbox ORDER BY workspace_id').all().map(Object.values),
        [[5, 'workspace-member-added'], [5, 'workspace-member-added']]);
    w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    w.client = await getClient(w.env, 'app');
    assert.equal((await providerSignIn(w)).id, user.id);
    await admitSession(w.env, w.client, (await issueSession(w.env, user, 'upstream')).session);
    assert.equal(source(w.db), 'workspace');
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 2);
});

test('an unverified provider claim cannot accept a workspace invitation even when open signup admits it', async t => {
    const w = await setup(t);
    workspace(w.db, 'joined'); invite(w.db, 'joined');
    const profile = { verified: false };
    await assert.rejects(providerSignIn(w, profile), { code: 'access_denied', status: 403, message: 'Account unavailable.' });
    assert.equal(source(w.db), undefined);
    w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    w.client = await getClient(w.env, 'app');
    await providerSignIn(w, profile);
    assert.equal(source(w.db), 'app');
    assert.deepEqual(Object.values(w.db.prepare('SELECT accepted_at,accepted_by FROM workspace_invitations').get()), [null, null]);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_members').get().n, 0);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 0);
});

test('provider admission refuses if the last membership disappears before the write', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    joinedWorkspace(w.db, user.id);
    const batch = w.env.DB.batch;
    t.mock.method(w.env.DB, 'batch', async statements => {
        w.db.prepare('DELETE FROM workspace_members WHERE user_id=?').run(user.id);
        return batch(statements);
    });
    await assert.rejects(providerSignIn(w, { authoritative: true }), { code: 'access_denied', status: 403, message: 'Account unavailable.' });
    assert.equal(source(w.db), undefined);
});

test('a concurrent workspace admission retains its source when the provider qualifies by app policy', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    joinedWorkspace(w.db, user.id);
    w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    w.client = await getClient(w.env, 'app');
    const batch = w.env.DB.batch;
    t.mock.method(w.env.DB, 'batch', async statements => {
        w.db.prepare("INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,'app',0,'workspace')").run(user.id);
        return batch(statements);
    });
    assert.equal((await providerSignIn(w, { authoritative: true })).id, user.id);
    assert.equal(source(w.db), 'workspace');
});
