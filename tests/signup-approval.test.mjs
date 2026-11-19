import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../apps/server/src/worker.mjs';
import { forgetRealms } from '../apps/server/src/realms/realm.mjs';
import { signupRequestLifetime } from '../apps/server/src/workspaces/signup-requests.mjs';
import { adminLogin } from './support/admin.mjs';
import { ask, count, invite, mint, person, refused, signupWorld, verify } from './support/signup.mjs';
import { begin, cookieJar, turnstile } from './support/world.mjs';

const signup = db => db.prepare('SELECT * FROM signup_requests WHERE email=?').get(person);
const endpoint = (id, action) => `signups/${id}/${action}`;
const approvalWorld = t => signupWorld(t, { realmSignup: 'approval' });

async function hold(w, options) {
    const flow = await mint(w, options);
    const response = await verify(w, flow, { browser_response: true });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(cookieJar(response), '', 'mailbox verification must not issue a session');
    const location = new URL((await response.json()).redirect);
    assert.equal(location.origin, w.env.ISSUER);
    assert.equal(location.pathname, '/signup-pending');
    assert.equal(location.searchParams.get('request_id'), flow.request_id);
    await w.drain();
    return { flow, path: location.pathname + location.search };
}

test('approval verifies in the original browser, holds without access and deduplicates verified requests across apps', async t => {
    const w = await signupWorld(t, { realmSignup: 'approval', botCheck: true });
    const { db } = w;
    turnstile(t);
    db.exec(`INSERT INTO admins(realm_id,email,role,created) VALUES('default','admin2@example.net','realm',0);
        INSERT INTO realms(id,display_name,config,status,created) VALUES('foreign','Foreign','{}','active',0);
        INSERT INTO admins(realm_id,email,role,created) VALUES('foreign','foreign@example.net','realm',0)`);
    const request = await begin(w);
    await refused(await ask(w, request), 400, 'turnstile_required');
    const hostile = { origin: 'https://wrong.example' };
    const first = await mint(w, { authorization: { ui_locales: 'fr' }, fields: { workspace_name: 'Team Notes', turnstile: crypto.randomUUID() } });
    const second = await mint(w, { client: 'other', fields: { workspace_name: 'Duplicate', turnstile: crypto.randomUUID() } });
    await refused(await verify(w, first, {}, hostile), 403, 'origin');
    await refused(await verify(w, { ...first, cookie: second.cookie }), 401, 'invalid_grant');
    assert.equal(count(db, 'signup_requests'), 0);
    const result = await verify(w, first, { browser_response: true });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(cookieJar(result), '');
    const path = new URL((await result.json()).redirect).href.slice(w.env.ISSUER.length);
    await refused(await w.call(path, { headers: { cookie: second.cookie } }), 403, 'browser_binding');
    const html = await (await w.call(path, { headers: { cookie: first.cookie, 'accept-language': 'de' } })).text();
    assert.match(html, /<html lang="fr"/);
    assert.match(html, /Votre demande est en attente d’approbation/);
    assert.match(html, /Nous vous enverrons un e-mail/);
    assert.match(html, /Notes/);
    await refused(await verify(w, first), 401, 'invalid_grant');
    const duplicate = await verify(w, second);
    assert.equal(duplicate.status, 303, await duplicate.clone().text());
    assert.match(duplicate.headers.get('location'), /\/signup-pending\?/);
    await w.drain();
    assert.equal(count(db, 'signup_requests'), 1);
    const row = signup(db);
    assert.deepEqual([row.email, row.client_id, row.product, row.status, row.workspace_name, row.locale],
        [person, 'app', 'notes', 'pending', 'Team Notes', 'fr']);
    assert.ok(row.verified_at <= Date.now() && row.verified_at >= row.created);
    const notices = w.mails.filter(mail => mail.subject === 'New sign-up request');
    assert.deepEqual(notices.map(mail => mail.to).sort(), ['admin2@example.net', 'admin@example.com']);
    assert.match(notices[0].text, /person@example\.com requested the workspace Team Notes in Notes \(app\) for product notes/);
    assert.match(notices[0].html, /https:\/\/id\.example\.com\/admin\/signups/);
    assert.match(notices[0].html, /<html lang="en"/);
    for (const table of ['users', 'sessions', 'workspaces', 'workspace_members', 'workspace_products', 'client_admissions', 'workspace_event_outbox', 'codes'])
        assert.equal(count(db, table), 0, table);
    const ordinary = await begin(w);
    const accepted = await w.post('/v1/auth/magic/request', { email: person, request_id: ordinary.request_id, turnstile: crypto.randomUUID() }, ordinary.cookie);
    assert.deepEqual(await accepted.json(), { accepted: true });
    const sent = w.mails.length;
    await w.drain();
    assert.equal(w.mails.length, sent);
    await refused(await w.call('/v1/me', { headers: { cookie: first.cookie } }), 401, 'login_required');
});

test('a realm admin approves in one batch, dispatches product events and sends branded mail in the stored locale', async t => {
    const w = await approvalWorld(t), { db } = w, queued = [];
    w.env.LOGOUT_QUEUE = { async send(event) { queued.push(event); } };
    db.exec(`UPDATE admins SET role='realm';
        UPDATE clients SET initiate_login_uri='HTTPS://app.example/start' WHERE id='app'`);
    const admin = await adminLogin(w);
    await hold(w, { fields: { workspace_name: 'Team Notes' }, authorization: { ui_locales: 'de' } });
    const row = signup(db);
    const list = await admin.get('signups');
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).requests.map(r => [r.id, r.status, r.app_name]), [[row.id, 'pending', 'Notes']]);

    const response = await admin.post(endpoint(row.id, 'approve'));
    assert.equal(response.status, 200, await response.clone().text());
    const { status, workspace_id, delivery } = await response.json();
    assert.equal(status, 'approved');
    assert.equal(delivery.state, 'sent');
    await w.drain();
    const owner = db.prepare('SELECT id,email_verified FROM users WHERE email=?').get(person);
    const actor = db.prepare("SELECT id FROM users WHERE email='admin@example.com'").get();
    const decided = signup(db);
    assert.deepEqual([decided.status, decided.decided_by, decided.reason], ['approved', actor.id, null]);
    assert.ok(decided.decided_at >= row.verified_at);
    const workspace = db.prepare('SELECT id,name,kind,created_via FROM workspaces').get();
    assert.deepEqual({ ...workspace }, { id: workspace_id, name: 'Team Notes', kind: 'team', created_via: 'signup' });
    assert.equal(owner.email_verified, 1);
    assert.deepEqual({ ...db.prepare('SELECT user_id,role FROM workspace_members').get() }, { user_id: owner.id, role: 'owner' });
    assert.equal(db.prepare('SELECT product FROM workspace_products').get().product, 'notes');
    assert.equal(db.prepare("SELECT source FROM client_admissions WHERE client_id='app'").get().source, 'workspace');
    const audit = db.prepare("SELECT actor,target,detail FROM audit WHERE event='workspace_signup'").get();
    assert.deepEqual([audit.actor, audit.target, JSON.parse(audit.detail).signup_request_id, JSON.parse(audit.detail).owner],
        [actor.id, workspace_id, row.id, owner.id]);
    assert.deepEqual(db.prepare('SELECT client_id,event,user_id FROM workspace_event_outbox ORDER BY client_id').all()
        .map(e => [e.client_id, e.event, e.user_id]), [['app', 'workspace-member-added', owner.id], ['other', 'workspace-member-added', owner.id]]);
    assert.equal(queued.length, 2);
    assert.ok(queued.every(event => event.type === 'workspace_event'));
    const notice = w.mails.at(-1);
    assert.equal(notice.to, person);
    assert.equal(notice.subject, 'Ihre Registrierung für Notes wurde genehmigt');
    assert.match(notice.html, /<html lang="de"/);
    assert.match(notice.html, /href="HTTPS:\/\/app\.example\/start"/);
    assert.deepEqual((await (await admin.get('signups')).json()).requests, []);
    assert.equal((await (await admin.get('signups?status=approved')).json()).requests[0].id, row.id);
    await refused(await admin.post(endpoint(row.id, 'approve')), 409, 'conflict');
    assert.equal(count(db, 'workspaces'), 1);
    const signIn = await mint(w);
    assert.equal(signIn.mail.subject, 'Sign in to Notes');
    assert.match((await verify(w, signIn)).headers.get('location'), /^https:\/\/app\.example\/callback\?code=/);
});

test('decline stores the optional reason for admins, sends a translated notice and creates nothing', async t => {
    const w = await approvalWorld(t), { db } = w, admin = await adminLogin(w);
    await hold(w, { authorization: { ui_locales: 'es' } });
    const { id } = signup(db);
    await refused(await admin.post(endpoint(id, 'decline'), { reason: { text: 'bad' } }), 400, 'invalid_request');
    await refused(await admin.post(endpoint(id, 'decline'), { reason: 'a'.repeat(501) }), 400, 'invalid_request');
    const response = await admin.post(endpoint(id, 'decline'), { reason: '  Capacity this month  ' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual([signup(db).status, signup(db).reason], ['declined', 'Capacity this month']);
    assert.equal((await (await admin.get('signups?status=declined')).json()).requests[0].reason, 'Capacity this month');
    const notice = w.mails.at(-1);
    assert.equal(notice.subject, 'Se rechazó tu solicitud de registro en Notes');
    assert.doesNotMatch(notice.text, /Capacity this month/);
    for (const table of ['workspaces', 'workspace_members', 'workspace_products', 'client_admissions', 'workspace_event_outbox'])
        assert.equal(count(db, table), 0, table);
    assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(person), undefined);
    await refused(await admin.post(endpoint(id, 'approve')), 409, 'conflict');
});

test('expiry is enforced before maintenance and the scheduled Worker records it', async t => {
    const w = await approvalWorld(t), { db } = w, admin = await adminLogin(w);
    await hold(w);
    const { id } = signup(db), deadline = Date.now() - signupRequestLifetime;
    db.prepare('UPDATE signup_requests SET verified_at=?, created=? WHERE id=?').run(deadline, deadline, id);
    await refused(await admin.post(endpoint(id, 'approve')), 409, 'conflict');
    assert.equal(signup(db).status, 'pending');
    await worker.scheduled({}, w.env);
    const expired = signup(db);
    assert.equal(expired.status, 'expired');
    assert.ok(expired.decided_at >= deadline + signupRequestLifetime);
    assert.equal(expired.decided_by, null);
    await refused(await admin.post(endpoint(id, 'approve')), 409, 'conflict');
    assert.equal(count(db, 'workspaces'), 0);
    await hold(w);
    assert.equal(count(db, 'signup_requests'), 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM signup_requests WHERE status='pending'").get().n, 1);
});

test('approval rechecks configuration and declines when an invitation now grants access', async t => {
    const w = await approvalWorld(t), { db } = w, admin = await adminLogin(w);
    await hold(w);
    const { id } = signup(db);
    db.exec("UPDATE realms SET config=json_set(config,'$.signup','off')");
    forgetRealms(w.env);
    await refused(await admin.post(endpoint(id, 'approve')), 403, 'access_denied');
    assert.equal(signup(db).status, 'pending');
    db.exec("UPDATE realms SET config=json_set(config,'$.signup','open')");
    forgetRealms(w.env);
    invite(db);
    const response = await admin.post(endpoint(id, 'approve'));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, 'declined');
    assert.match(signup(db).reason, /already has access or an active invitation/);
    assert.equal(count(db, 'workspaces'), 1, 'only the invitation workspace exists');
    assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(person), undefined);
    assert.equal(db.prepare("SELECT accepted_by FROM workspace_invitations WHERE id='invite'").get().accepted_by, null);
});
