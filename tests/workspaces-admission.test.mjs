import test from 'node:test';
import assert from 'node:assert/strict';
import { login, world } from './support/world.mjs';
import { admitted, admitSession, ensureUser } from '../apps/server/src/services/admission.mjs';
import { getClient } from '../apps/server/src/oidc/clients.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';

const email = 'person@example.com';
async function setup(t) {
    const w = await world(t, 'invited'), db = w.env.DB.db;
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
        UPDATE clients SET workspaces='shared', product='notes', backchannel_uri='https://app.example/events' WHERE id='app';
        UPDATE clients SET workspaces='shared', product='files', backchannel_uri='https://other.example/events' WHERE id='other';`);
    return { ...w, db, client: await getClient(w.env, 'app') };
}
function workspace(db, id, products = ['notes'], status = 'active') {
    db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,status,version,created) VALUES(?,'default','team',?,?,4,0)").run(id, id, status);
    for (const product of products) db.prepare('INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,?,0)').run(id, product);
}
function invite(db, id, role = 'member', expires = Date.now() + 60_000, revoked = null) {
    db.prepare('INSERT INTO workspace_invitations(id,workspace_id,email,role,created,expires_at,revoked_at) VALUES(?,?,?,?,0,?,?)')
        .run(`invite-${id}`, id, email, role, expires, revoked);
}
const source = db => db.prepare("SELECT source FROM client_admissions WHERE client_id='app'").get()?.source;
for (const policy of ['existing', 'open', 'invitation', 'domain']) test(`shared admission rule 1 uses app policy (${policy})`, async t => {
    const w = await setup(t);
    if (policy === 'existing') {
        const user = await ensureUser(w.env, email);
        w.db.prepare("INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,'app',0,'app')").run(user.id);
    }
    if (policy === 'open') w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    if (policy === 'invitation') w.db.prepare("INSERT INTO invitations(client_id,email,expires_at) VALUES('app',?,?)").run(email, Date.now() + 60_000);
    if (policy === 'domain') w.db.exec(`UPDATE clients SET allowed_domains='["example.com"]' WHERE id='app'`);
    const signed = await login(w, t, email);
    assert.ok(signed.code);
    assert.equal((await w.exchange(signed.code)).status, 200);
    assert.equal(source(w.db), 'app');
});

test('shared admission rule 2 uses membership and later SSO preserves the workspace source', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    workspace(w.db, 'joined');
    w.db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('joined',?,'viewer',0,0)").run(user.id);
    const signed = await login(w, t, email);
    assert.ok(signed.code);
    assert.equal((await w.exchange(signed.code)).status, 200);
    assert.equal(source(w.db), 'workspace');
    w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    invite(w.db, 'joined');
    const next = await w.authorize({}, signed.cookie);
    assert.ok(new URL(next.headers.get('location')).searchParams.get('code'));
    assert.equal(source(w.db), 'workspace');
    assert.equal(w.db.prepare('SELECT accepted_at FROM workspace_invitations').get().accepted_at, null);
});

test('shared admission rule 3 accepts every matching invitation, records role and version, and fans out events', async t => {
    const w = await setup(t);
    workspace(w.db, 'alpha', ['notes', 'files']); invite(w.db, 'alpha', 'viewer');
    workspace(w.db, 'beta'); invite(w.db, 'beta', 'owner');
    workspace(w.db, 'unrelated', ['files']); invite(w.db, 'unrelated');
    const signed = await login(w, t, email);
    assert.ok(signed.code);
    assert.equal((await w.exchange(signed.code)).status, 200);
    assert.equal(source(w.db), 'workspace');
    const { id } = w.db.prepare('SELECT id FROM users WHERE email=?').get(email);
    assert.deepEqual(w.db.prepare('SELECT workspace_id,user_id,role FROM workspace_members ORDER BY workspace_id').all().map(Object.values),
        [['alpha', id, 'viewer'], ['beta', id, 'owner']]);
    assert.deepEqual(w.db.prepare('SELECT id,version FROM workspaces ORDER BY id').all().map(Object.values), [['alpha', 5], ['beta', 5], ['unrelated', 4]]);
    const invitations = w.db.prepare('SELECT accepted_at,accepted_by FROM workspace_invitations ORDER BY workspace_id').all();
    for (const invitation of invitations.slice(0, 2)) {
        assert.ok(invitation.accepted_at > 0);
        assert.equal(invitation.accepted_by, id);
    }
    assert.deepEqual(Object.values(invitations[2]), [null, null]);
    const events = w.db.prepare('SELECT client_id,workspace_id,user_id,event,version,payload FROM workspace_event_outbox ORDER BY workspace_id,client_id').all();
    assert.deepEqual(events.map(({ payload, ...row }) => [row.client_id, row.user_id, row.event, row.version, JSON.parse(payload)]), [
        ['app', id, 'workspace-member-added', 5, { workspace_id: 'alpha', version: 5, role: 'viewer' }],
        ['other', id, 'workspace-member-added', 5, { workspace_id: 'alpha', version: 5, role: 'viewer' }],
        ['app', id, 'workspace-member-added', 5, { workspace_id: 'beta', version: 5, role: 'owner' }]
    ]);
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM audit WHERE event='workspace-member-added' AND actor=?").get(id).n, 2);
    await w.authorize({}, signed.cookie);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 3);
});

test('accepting an invitation for a current member preserves their role and records eligible app policy', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    workspace(w.db, 'joined'); invite(w.db, 'joined', 'viewer');
    w.db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('joined',?,'owner',0,0)").run(user.id);
    w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    await admitSession(w.env, w.client, (await issueSession(w.env, user, 'email')).session);
    assert.equal(w.db.prepare('SELECT role FROM workspace_members').get().role, 'owner');
    assert.equal(w.db.prepare('SELECT version FROM workspaces').get().version, 4);
    assert.equal(w.db.prepare('SELECT accepted_by FROM workspace_invitations').get().accepted_by, user.id);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 0);
    assert.equal(source(w.db), 'app');
});

test('a later session leaves an existing app admission and workspace invitations untouched', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    workspace(w.db, 'joined'); invite(w.db, 'joined');
    w.db.prepare("INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,'app',0)").run(user.id);
    await admitSession(w.env, w.client, (await issueSession(w.env, user, 'email')).session);
    assert.equal(source(w.db), 'app');
    assert.equal(w.db.prepare('SELECT accepted_at FROM workspace_invitations').get().accepted_at, null);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_members').get().n, 0);
});

for (const reason of ['claim', 'expired', 'revoked', 'different product', 'closed', 'realm switch off', 'app workspaces', 'missing product', 'different realm']) {
    test(`workspace invitation cannot admit with ${reason}`, async t => {
        const w = await setup(t);
        workspace(w.db, 'team', reason === 'different product' ? ['files'] : ['notes'], reason === 'closed' ? 'closed' : 'active');
        invite(w.db, 'team', 'member', Date.now() + (reason === 'expired' ? -1000 : 60_000), reason === 'revoked' ? Date.now() : null);
        if (reason === 'realm switch off') w.db.exec("UPDATE realms SET config=json_remove(config,'$.workspaces') WHERE id='default'");
        if (reason === 'app workspaces') w.db.exec("UPDATE clients SET workspaces='app' WHERE id='app'");
        if (reason === 'missing product') w.db.exec("UPDATE clients SET product=NULL WHERE id='app'");
        if (reason === 'different realm') w.db.exec(`INSERT INTO realms(id,display_name,created) VALUES('another','Another realm',0);
            UPDATE workspaces SET realm_id='another' WHERE id='team';`);
        const client = await getClient(w.env, 'app');
        const proof = reason === 'claim' ? 'claim' : 'mailbox';
        assert.equal(await admitted(w.env, client, email, proof), false);
        const user = await ensureUser(w.env, email);
        const session = (await issueSession(w.env, user, reason === 'claim' ? 'upstream' : 'email')).session;
        await assert.rejects(admitSession(w.env, client, session), { code: 'access_denied' });
        assert.deepEqual(Object.values(w.db.prepare('SELECT accepted_at,accepted_by FROM workspace_invitations').get()), [null, null]);
        assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_members').get().n, 0);
        assert.equal(source(w.db), undefined);
    });
}

test('a claim session can use open signup without accepting a workspace invitation', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email, false);
    workspace(w.db, 'team'); invite(w.db, 'team');
    w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    const client = await getClient(w.env, 'app');
    assert.equal(await admitted(w.env, client, email, 'claim'), true);
    await admitSession(w.env, client, (await issueSession(w.env, user, 'upstream')).session);
    assert.equal(source(w.db), 'app');
    assert.equal(w.db.prepare('SELECT accepted_at FROM workspace_invitations').get().accepted_at, null);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 0);
});

test('an invitation revoked before the batch rolls back earlier claims and events', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    workspace(w.db, 'alpha'); invite(w.db, 'alpha');
    workspace(w.db, 'beta'); invite(w.db, 'beta');
    const session = (await issueSession(w.env, user, 'email')).session;
    const batch = w.env.DB.batch;
    t.mock.method(w.env.DB, 'batch', statements => {
        w.db.prepare("UPDATE workspace_invitations SET revoked_at=? WHERE id='invite-beta'").run(Date.now());
        return batch(statements);
    });
    await assert.rejects(admitSession(w.env, w.client, session), { code: 'conflict', status: 409 });
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_members').get().n, 0);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_invitations WHERE accepted_at IS NOT NULL').get().n, 0);
    assert.equal(w.db.prepare('SELECT sum(version) AS n FROM workspaces').get().n, 8);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 0);
    assert.equal(source(w.db), undefined);
});

test('two sign-ins racing for the same invitation emit one event and one version increment', async t => {
    const w = await setup(t), user = await ensureUser(w.env, email);
    workspace(w.db, 'team'); invite(w.db, 'team');
    const sessions = await Promise.all([issueSession(w.env, user, 'email'), issueSession(w.env, user, 'email')]);
    const batch = w.env.DB.batch;
    let arrived = 0;
    const barrier = Promise.withResolvers();
    t.mock.method(w.env.DB, 'batch', async statements => {
        arrived++;
        if (arrived === sessions.length) barrier.resolve();
        await barrier.promise;
        return batch(statements);
    });
    const results = await Promise.allSettled(sessions.map(({ session }) => admitSession(w.env, w.client, session)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'conflict');
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_members').get().n, 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 1);
    assert.equal(w.db.prepare('SELECT version FROM workspaces').get().version, 5);
});
