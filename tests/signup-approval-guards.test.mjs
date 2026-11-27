import assert from 'node:assert/strict';
import test from 'node:test';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { adminLogin } from './support/admin.mjs';
import { count, mint, person, refused, signupWorld, verify } from './support/signup.mjs';

async function setup(t) {
    const w = await signupWorld(t, { realmSignup: 'approval' }), { db } = w;
    const admin = await adminLogin(w);
    const flow = await mint(w), held = await verify(w, flow);
    assert.equal(held.status, 303, await held.clone().text());
    await w.drain();
    const id = db.prepare("SELECT id FROM signup_requests WHERE status='pending'").get().id;
    return { w, db, admin, id, approve: `signups/${id}/approve`, decline: `signups/${id}/decline` };
}

test('a pending sign-up cannot be approved after the applicant becomes a platform administrator', async t => {
    const { db, admin, approve, id } = await setup(t);
    db.prepare("INSERT INTO admins VALUES('default',?,'platform',0,NULL)").run(person);
    await refused(await admin.post(approve), 409, 'conflict');
    assert.equal(db.prepare('SELECT status FROM signup_requests WHERE id=?').get(id).status, 'pending');
    for (const table of ['workspaces', 'client_admissions', 'workspace_event_outbox']) assert.equal(count(db, table), 0);
});

test('sign-up admin API requires a realm admin, confirmed second factor, fresh authentication, CSRF and Origin', async t => {
    const { w, db, admin, approve, decline } = await setup(t);
    const user = await ensureUser(w.env, 'member@example.net');
    const signed = await issueSession(w.env, user, 'email');
    const cookie = signed.cookies.map(value => value.split(';')[0]).join('; ');
    const csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const get = cookie => w.call('/admin/api/signups', { headers: { cookie } });
    await refused(await get(''), 401, 'login_required');
    await refused(await get(cookie), 403, 'admin_required');
    for (const path of [approve, decline]) {
        await refused(await w.post('/admin/api/' + path, {}, cookie, { 'x-csrf-token': csrf }), 403, 'admin_required');
        await refused(await w.post('/admin/api/' + path, {}, admin.cookie), 403, 'csrf');
        await refused(await admin.post(path, {}, { origin: 'https://other.example' }), 403, 'origin');
    }
    db.exec('UPDATE sessions SET mfa_at=NULL WHERE admin_until IS NOT NULL');
    await refused(await get(admin.cookie), 403, 'mfa_required');
    for (const path of [approve, decline]) await refused(await admin.post(path), 403, 'mfa_required');
    db.prepare('UPDATE sessions SET mfa_at=?,auth_time=? WHERE admin_until IS NOT NULL').run(Date.now(), Math.floor(Date.now() / 1000) - 601);
    assert.equal((await get(admin.cookie)).status, 200);
    for (const path of [approve, decline]) await refused(await admin.post(path), 403, 'reauth_required');
    assert.equal(db.prepare('SELECT status FROM signup_requests').get().status, 'pending');
    assert.equal(count(db, 'workspaces'), 0);
});

test('the decision batch rechecks the admin factor and cannot write after factor removal', async t => {
    const { w, db, admin, approve } = await setup(t);
    const batch = w.env.DB.batch.bind(w.env.DB);
    t.mock.method(w.env.DB, 'batch', async statements => {
        db.exec('DELETE FROM mfa_factors');
        return batch(statements);
    });
    await refused(await admin.post(approve), 409, 'conflict');
    assert.equal(db.prepare('SELECT status FROM signup_requests').get().status, 'pending');
    assert.equal(count(db, 'workspaces'), 0);
});

test('a realm admin can neither list nor decide another realm’s request', async t => {
    const { w, db, admin, id, approve } = await setup(t);
    db.exec("INSERT INTO realms(id,display_name,config,status,created) VALUES('foreign','Foreign','{}','active',0)");
    db.prepare('UPDATE signup_requests SET realm_id=? WHERE id=?').run('foreign', id);
    assert.deepEqual(await (await admin.get('signups')).json(), { requests: [], next: null });
    await refused(await admin.post(approve), 404, 'not_found');
    await refused(await admin.get('signups?status=unknown'), 400, 'invalid_request');
    assert.equal(db.prepare('SELECT status FROM signup_requests').get().status, 'pending');
    await w.drain();
});

test('simultaneous decisions have one winner and send one notice; outbox failure rolls back approval', async t => {
    const { w, db, admin, approve, decline } = await setup(t);
    db.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON workspace_event_outbox
        BEGIN SELECT RAISE(ABORT,'test delivery write failure'); END`);
    await refused(await admin.post(approve), 500, 'server_error');
    assert.equal(db.prepare('SELECT status FROM signup_requests').get().status, 'pending');
    assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(person), undefined);
    assert.equal(count(db, 'workspaces'), 0);
    db.exec('DROP TRIGGER reject_event');
    const prior = w.mails.length;
    const results = await Promise.all([admin.post(approve), admin.post(decline)]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
    const decision = await results.find(response => response.status === 200).json();
    assert.equal(db.prepare('SELECT status FROM signup_requests').get().status, decision.status);
    assert.equal(count(db, 'workspaces'), decision.status === 'approved' ? 1 : 0);
    assert.equal(w.mails.length - prior, 1);
    await w.drain();
});

test('approval reuses an imported subject and reports mail transport failure without repeating the decision', async t => {
    const { w, db, admin, id, approve } = await setup(t);
    db.prepare("INSERT INTO users(id,email,created,email_verified) VALUES('imported',?,0,0)").run(person);
    w.env.EMAIL = { async send() { throw new Error('test transport unavailable'); } };
    const response = await admin.post(approve);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).delivery, { state: 'failed', message: 'The decision is saved. Email delivery failed.' });
    assert.equal(db.prepare("SELECT email_verified FROM users WHERE id='imported'").get().email_verified, 1);
    assert.equal(db.prepare('SELECT user_id FROM workspace_members').get().user_id, 'imported');
    const event = db.prepare("SELECT detail FROM audit WHERE event='signup_email_failed'").get();
    assert.deepEqual(JSON.parse(event.detail), { request_id: id, kind: 'signup_approved' });
    await refused(await admin.post(approve), 409, 'conflict');
    await w.drain();
});

test('approval declines an applicant who already owns a closed sign-up workspace for the product', async t => {
    const { w, db, admin, approve } = await setup(t);
    const user = await ensureUser(w.env, person);
    db.exec(`INSERT INTO workspaces(id,realm_id,kind,name,status,created,created_via)
            VALUES('past','default','team','Past team','closed',0,'signup');
        INSERT INTO workspace_products(workspace_id,product,created) VALUES('past','notes',0)`);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('past',?,'owner',0,0)").run(user.id);
    const mails = w.mails.length, response = await admin.post(approve);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual([body.status, body.delivery], ['declined', { state: 'skipped' }]);
    assert.equal(body.automatic, undefined);
    await w.drain();
    assert.equal(w.mails.length, mails, 'an applicant who can already sign in gets no decline notice');
    assert.match(db.prepare('SELECT reason FROM signup_requests').get().reason, /already owns/);
    assert.equal(count(db, 'workspaces'), 1);
    assert.equal(count(db, 'client_admissions'), 0);
});

test('approval email uses the issuer sign-in URL when the app has no initiate-login URL', async t => {
    const { w, admin, approve } = await setup(t);
    const response = await admin.post(approve);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(w.mails.at(-1).html, /href="https:\/\/id\.example\.com\/login"/);
    await w.drain();
});

test('status filtering and pagination preserve the newest-first order with no duplicates', async t => {
    const { admin, db, id } = await setup(t);
    const verified = db.prepare('SELECT verified_at FROM signup_requests WHERE id=?').get(id).verified_at;
    const insert = db.prepare(`INSERT INTO signup_requests
        (id,realm_id,client_id,product,email,workspace_name,locale,created,verified_at,status)
        VALUES(?,'default','app','notes',?,'Other team','en',?,?,?)`);
    const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
    for (const [index, request] of ids.entries())
        insert.run(request, `person-${index}@example.com`, verified - 1 - index, verified - 1 - index, 'pending');
    const declined = crypto.randomUUID();
    insert.run(declined, 'declined@example.com', verified, verified, 'declined');
    const first = await (await admin.get('signups')).json();
    assert.deepEqual(first.requests.map(row => row.id), [id, ...ids.slice(0, 49)]);
    assert.equal(first.next, ids[48]);
    const next = await (await admin.get('signups?before=' + first.next)).json();
    assert.deepEqual(next.requests.map(row => row.id), ids.slice(-1));
    assert.equal(next.next, null);
    const filter = await (await admin.get('signups?status=declined')).json();
    assert.deepEqual(filter.requests.map(row => row.id), [declined]);
    await refused(await admin.get('signups?before=invalid'), 400, 'invalid_request');
});

test('admin notification failure does not undo the hold or send a duplicate to another administrator', async t => {
    const w = await signupWorld(t, { realmSignup: 'approval' }), { db } = w;
    db.exec("INSERT INTO admins(realm_id,email,role,created) VALUES('default','unavailable@example.net','realm',0)");
    const send = w.env.EMAIL.send.bind(w.env.EMAIL);
    w.env.EMAIL.send = async mail => {
        if (mail.to === 'unavailable@example.net') throw new Error('test transport failure');
        return send(mail);
    };
    for (let i = 0; i < 2; ++i) {
        const response = await verify(w, await mint(w));
        assert.equal(response.status, 303);
        await w.drain();
    }
    assert.equal(w.mails.filter(mail => mail.subject === 'New sign-up request').length, 1);
    assert.equal(count(db, 'signup_requests'), 1);
    const event = db.prepare("SELECT detail FROM audit WHERE event='signup_email_failed'").get();
    const request = db.prepare("SELECT id FROM signup_requests WHERE status='pending'").get();
    assert.deepEqual(JSON.parse(event.detail), { request_id: request.id, kind: 'signup_admin_request', failed: 1 });
});
