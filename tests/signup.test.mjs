import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../apps/server/src/worker.mjs';
import { dispatchDeliveries } from '../apps/server/src/services/outbox.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { basic, begin, cookieJar } from './support/world.mjs';
import { ask, count, invite, mint, person, refused, signupWorld, verify } from './support/signup.mjs';

const claims = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
const authCode = response => new URL(response.headers.get('location')).searchParams.get('code');

test('signup creates one verified owner and delivers version 1 to the product apps', async t => {
    const w = await signupWorld(t), { db } = w, queued = [], delivered = new Map();
    w.env.LOGOUT_QUEUE = { async send(message) { queued.push(message); } };
    db.exec(`INSERT INTO clients(id,redirect_uris,workspaces,product,backchannel_uri)
        VALUES('unrelated','["https://unrelated.example/cb"]','shared','tasks','https://unrelated.example/events'),
        ('standalone','["https://standalone.example/cb"]','app','notes','https://standalone.example/events')`);
    const flow = await mint(w, { fields: { workspace_name: '  Team Notes  ' } });
    assert.equal(flow.mail.subject, 'Create an account for Notes');
    assert.match(flow.mail.html, /Create an account for Notes/);
    assert.equal(count(db, 'users'), 0, 'delivery is not mailbox proof');
    const row = db.prepare('SELECT purpose,workspace_name,expires_at FROM magic_links').get();
    assert.equal(row.purpose, 'signup');
    assert.equal(row.workspace_name, 'Team Notes');
    assert.ok(row.expires_at > Date.now() + 899000 && row.expires_at <= Date.now() + 900000);

    const response = await verify(w, flow);
    assert.equal(response.status, 303, await response.clone().text());
    const user = db.prepare('SELECT * FROM users').get(), workspace = db.prepare('SELECT * FROM workspaces').get();
    assert.equal(user.email, person);
    assert.equal(user.email_verified, 1);
    assert.deepEqual([workspace.name, workspace.kind, workspace.version, workspace.created_via, workspace.personal_owner],
        ['Team Notes', 'team', 1, 'signup', null]);
    assert.deepEqual({ ...db.prepare('SELECT workspace_id,user_id,role FROM workspace_members').get() },
        { workspace_id: workspace.id, user_id: user.id, role: 'owner' });
    assert.equal(db.prepare('SELECT product FROM workspace_products').get().product, 'notes');
    assert.equal(db.prepare("SELECT source FROM client_admissions WHERE client_id='app'").get().source, 'workspace');
    const audit = db.prepare("SELECT actor,target,detail FROM audit WHERE event='workspace_signup'").get();
    assert.deepEqual([audit.actor, audit.target, JSON.parse(audit.detail).version], [user.id, workspace.id, 1]);

    const exchanged = await (await w.exchange(authCode(response))).json();
    assert.equal(claims(exchanged.id_token).sub, user.id);
    const appRead = path => w.call(path, { headers: { authorization: basic() } }).then(r => r.json());
    const listed = await appRead('/v1/memberships?' + new URLSearchParams({ sub: user.id }));
    assert.deepEqual(listed.memberships.map(row => [row.workspace_id, row.created_via]), [[workspace.id, 'signup']]);
    assert.equal((await appRead('/v1/workspaces/' + workspace.id)).created_via, 'signup');
    const sso = await w.authorize({ client_id: 'other', prompt: 'none' }, cookieJar(response));
    assert.equal(sso.status, 303);
    const second = await (await w.exchange(authCode(sso), {}, basic('other'))).json();
    assert.equal(claims(second.id_token).sub, user.id);
    assert.equal(db.prepare("SELECT source FROM client_admissions WHERE client_id='other'").get().source, 'workspace');

    t.mock.method(globalThis, 'fetch', async (uri, init) => {
        assert.equal(init.method, 'POST');
        delivered.set(String(uri), claims(init.body.get('workspace_token')));
        return new Response(null, { status: 204 });
    });
    await dispatchDeliveries(w.env);
    assert.equal(queued.length, 2);
    for (const body of queued) {
        assert.equal(body.type, 'workspace_event');
        let acknowledged = false;
        await worker.queue({ messages: [{ body, ack() { acknowledged = true; }, retry() {} }] }, w.env);
        assert.ok(acknowledged);
    }
    assert.equal(delivered.size, 2);
    for (const client of ['app', 'other']) {
        const event = delivered.get(`https://${client}.example/events`);
        assert.equal(event.aud, client);
        assert.equal(event.sub, user.id);
        assert.deepEqual(event.events, { [w.env.ISSUER + '/events/workspace-member-added']: { workspace_id: workspace.id, role: 'owner', version: 1 } });
    }
});

test('signup reuses an imported subject and claims an unverified mailbox in the same write', async t => {
    const w = await signupWorld(t), { db } = w;
    db.prepare("INSERT INTO users(id,email,created,email_verified) VALUES('imported',?,0,0)").run(person);
    db.exec("INSERT INTO user_identities(provider,provider_id,user_id,created) VALUES('github','42','imported',0)");
    const user = db.prepare('SELECT * FROM users').get();
    await issueSession(w.env, user, 'github');
    const flow = await mint(w);
    const response = await verify(w, flow, { browser_response: true });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match((await response.json()).redirect, /^https:\/\/app\.example\/callback\?code=/);
    assert.equal(db.prepare('SELECT id FROM users').get().id, 'imported');
    assert.equal(db.prepare('SELECT email_verified FROM users').get().email_verified, 1);
    assert.equal(db.prepare('SELECT name FROM workspaces').get().name, "person's workspace");
    assert.equal(db.prepare('SELECT user_id FROM workspace_members').get().user_id, 'imported');
    assert.equal(count(db, 'user_identities'), 0);
    assert.equal(db.prepare('SELECT method FROM sessions').get().method, 'email');
});

test('existing admissions and open product invitations get an ordinary sign-in email with the same public response', async t => {
    const w = await signupWorld(t), { db } = w, flow = await begin(w);
    const existing = await ensureUser(w.env, 'admitted@example.com');
    db.prepare("INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,'app',0)").run(existing.id);
    invite(db, 'invited@example.com');
    const responses = [];
    for (const [email, purpose, subject] of [[existing.email, 'sign_in', 'Sign in to Notes'],
        ['invited@example.com', 'sign_in', 'Sign in to Notes'], [person, 'signup', 'Create an account for Notes']]) {
        const response = await ask(w, flow, email, { workspace_name: 'New team' });
        responses.push([response.status, response.headers.get('content-type'), await response.text()]);
        await w.drain();
        const row = db.prepare('SELECT purpose,workspace_name FROM magic_links WHERE email=?').get(email);
        assert.deepEqual([row.purpose, row.workspace_name], [purpose, purpose === 'signup' ? 'New team' : null]);
        assert.equal(w.mails.at(-1).subject, subject);
    }
    assert.deepEqual(responses, Array(3).fill([202, 'application/json', '{"accepted":true}']));
    const token = w.mails[1].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const result = await verify(w, { ...flow, token });
    assert.equal(result.status, 303, await result.clone().text());
    const accepted = db.prepare("SELECT accepted_by FROM workspace_invitations WHERE id='invite'").get().accepted_by;
    assert.ok(accepted);
    assert.equal(db.prepare('SELECT role FROM workspace_members WHERE user_id=?').get(accepted).role, 'member');
    assert.equal(db.prepare("SELECT source FROM client_admissions WHERE user_id=? AND client_id='app'").get(accepted).source, 'workspace');
    assert.equal(count(db, 'workspaces'), 1);
    db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    const open = await mint(w, { email: 'open-policy@example.com' });
    assert.equal(open.mail.subject, 'Sign in to Notes');
    assert.equal((await verify(w, open)).status, 303);
    assert.equal(count(db, 'workspaces'), 1);
});

test('simultaneous signup links from apps of the same product can only create one workspace', async t => {
    const w = await signupWorld(t);
    const first = await mint(w), second = await mint(w, { client: 'other' });
    const results = await Promise.all([verify(w, first), verify(w, second)]);
    assert.deepEqual(results.map(result => result.status).sort(), [303, 409]);
    await refused(results.find(result => result.status === 409), 409, 'signup_limit');
    assert.equal(count(w.db, 'workspaces'), 1);
    assert.equal(count(w.db, 'users'), 1);
    assert.equal(count(w.db, 'workspace_members'), 1);
    assert.equal(count(w.db, 'client_admissions'), 1);
    w.db.exec("UPDATE clients SET product='tasks' WHERE id='other'");
    assert.equal((await verify(w, await mint(w, { client: 'other' }))).status, 303);
    assert.equal(count(w.db, 'workspaces'), 2);
    assert.equal(count(w.db, 'users'), 1);
});

test('an outbox write error rolls back the new account, workspace, membership and admission', async t => {
    const w = await signupWorld(t), flow = await mint(w);
    w.db.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON workspace_event_outbox
        BEGIN SELECT RAISE(ABORT,'test delivery write failure'); END`);
    await refused(await verify(w, flow), 500, 'server_error');
    for (const table of ['users', 'workspaces', 'workspace_members', 'workspace_products', 'client_admissions', 'workspace_event_outbox', 'sessions'])
        assert.equal(count(w.db, table), 0, table);
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM audit WHERE event='workspace_signup'").get().n, 0);
    await refused(await verify(w, flow), 401, 'invalid_grant');
});
