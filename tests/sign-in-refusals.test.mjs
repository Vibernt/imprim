import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';
import { adminLogin } from './support/admin.mjs';
import { linkToken } from './support/provider-signup.mjs';
import { ask, count, mint, signupWorld, verify } from './support/signup.mjs';
import { begin, cookieJar, login, turnstile, world } from './support/world.mjs';

const requestPath = '/v1/auth/magic/request', verifyPath = '/v1/auth/magic/verify';
const requestLink = (w, flow, email, extras = {}, headers = {}) => w.post(requestPath,
    { request_id: flow.request_id, email, turnstile: crypto.randomUUID(), browser_page: true, ...extras }, flow.cookie, headers);
const auditRows = db => db.prepare("SELECT actor,target,realm_id,detail FROM audit WHERE event='sign_in_refused' ORDER BY id").all()
    .map(row => ({ ...row, detail: JSON.parse(row.detail) }));
const platformPage = /This address manages Vibernt, so it can&#39;t sign in to apps\. Use another address\./;

for (const reason of ['not_invited', 'admin_address', 'account_unavailable', 'rate_limited', 'turnstile_failed', 'link_skipped']) {
    test(`email link refusal records ${reason} with masked and hashed email`, async t => {
        const w = await world(t, reason === 'not_invited' ? 'invited' : 'open'), db = w.env.DB.db;
        const email = reason === 'admin_address' ? 'Admin@Example.COM' : 'Person@Example.COM';
        const address = email.toLowerCase(), hash = await sha256(address);
        const logs = t.mock.method(console, 'log', () => {});
        const errors = t.mock.method(console, 'error', () => {});
        turnstile(t, reason === 'turnstile_failed' ? { success: false } : {});
        if (reason === 'account_unavailable') db.prepare("INSERT INTO users(id,email,status,created) VALUES('blocked',?,'blocked',0)").run(address);
        if (reason === 'rate_limited') db.prepare('INSERT INTO rate_limits VALUES(?,5,?)').run('email-recipient:' + hash, Date.now() + 60000);
        if (reason === 'link_skipped') w.env.EMAIL.send = async () => { throw new Error(email); };
        const flow = await begin(w);
        const response = await requestLink(w, flow, email);
        assert.equal(response.status, reason === 'turnstile_failed' ? 400 : 200);
        if (response.ok) assert.deepEqual(await response.json(), { accepted: true });
        await w.drain();
        assert.equal(w.mails.length, 0);
        assert.equal(count(db, 'magic_links'), 0);
        const detail = { reason, method: 'email', client_id: 'app', email: address[0] + '***@example.com', email_hash: hash };
        assert.equal(logs.mock.callCount(), 1);
        const [line] = logs.mock.calls[0].arguments;
        assert.ok(!line.toLowerCase().includes(address));
        assert.ok(errors.mock.calls.every(call => !JSON.stringify(call.arguments).toLowerCase().includes(address)));
        assert.deepEqual(JSON.parse(line), { type: 'sign_in_refused', ...detail, realm_id: 'default' });
        const rows = auditRows(db);
        if (['rate_limited', 'turnstile_failed'].includes(reason)) assert.deepEqual(rows, []);
        else assert.deepEqual(rows, [{ actor: null, target: 'app', realm_id: 'default', detail }]);
    });
}

test('invite-only copy is visible on sign-in and check-email while the email outcome stays neutral', async t => {
    const w = await signupWorld(t, { appSignup: 'off' });
    const copy = /Notes is invite-only for now\. Use the address you were invited with, or ask the person who invited you\./;
    const signIn = await (await w.authorize()).text();
    const flow = await begin(w);
    const login = await w.call('/login?request_id=' + flow.request_id, { headers: { cookie: flow.cookie } });
    for (const html of [signIn, await login.text()]) {
        assert.match(html, copy);
        assert.doesNotMatch(html, /id="open-signup"/);
    }
    const response = await requestLink(w, flow, 'admin@example.com');
    const checkPath = '/check-email?request_id=' + flow.request_id;
    const checked = await w.call(checkPath, { headers: { cookie: [flow.cookie, cookieJar(response)].join('; ') } });
    assert.match(await checked.text(), /If admin@example\.com can sign in here, a link is on its way\.[\s\S]*Notes is invite-only for now/);
    assert.equal((await w.call(checkPath)).status, 403);
    await w.drain();
    assert.equal(w.mails.length, 0);
    w.db.exec("UPDATE clients SET self_signup='on' WHERE id='app'");
    const enabled = await w.call('/login?request_id=' + flow.request_id, { headers: { cookie: flow.cookie } });
    const html = await enabled.text();
    assert.doesNotMatch(html, copy);
    assert.match(html, /id="open-signup"/);
    const enabledCheck = await w.call(checkPath, { headers: { cookie: flow.cookie } });
    assert.doesNotMatch(await enabledCheck.text(), copy);
});

test('an app link becomes unusable if a realm admin becomes platform before clicking, with browser, Origin and single-use checks', async t => {
    const w = await world(t), db = w.env.DB.db;
    turnstile(t);
    db.exec("UPDATE admins SET role='realm' WHERE email='admin@example.com'");
    const flow = await begin(w);
    assert.equal((await requestLink(w, flow, 'admin@example.com')).status, 200);
    await w.drain();
    assert.equal(w.mails.length, 1);
    const token = linkToken(w);
    db.exec("UPDATE admins SET role='platform' WHERE email='admin@example.com'");
    assert.equal((await w.post(verifyPath, { token }, (await begin(w)).cookie)).status, 401);
    assert.equal((await w.post(verifyPath, { token }, flow.cookie, { origin: 'https://other.example.com' })).status, 403);
    assert.equal(auditRows(db).length, 0);
    const refused = await w.post(verifyPath, { token, browser_response: true }, flow.cookie);
    assert.equal(refused.status, 200);
    assert.equal(refused.headers.get('set-cookie'), null);
    const html = await refused.text();
    assert.match(html, platformPage);
    assert.ok(html.includes(`href="/login?request_id=${flow.request_id}"`));
    assert.doesNotMatch(html, /<style|\sstyle=|<script[^>]*src="\/fire\//);
    assert.equal((await w.post(verifyPath, { token }, flow.cookie)).status, 401);
    for (const table of ['users', 'sessions', 'client_admissions', 'codes']) assert.equal(count(db, table), 0);
});

test('realm and platform roster roles are realm-local, including session reuse and code exchange', async t => {
    const w = await world(t), db = w.env.DB.db;
    db.exec(`UPDATE admins SET role='realm' WHERE email='admin@example.com';
        INSERT INTO realms(id,display_name,created) VALUES('other-realm','Other',0);
        INSERT INTO admins VALUES('other-realm','admin@example.com','platform',0,NULL);`);
    const signed = await login(w, t, 'admin@example.com');
    const consoleSession = await adminLogin(w);
    const reused = await w.authorize({}, consoleSession.cookie);
    assert.ok(new URL(reused.headers.get('location')).searchParams.get('code'));
    db.exec("UPDATE admins SET role='platform' WHERE realm_id='default' AND email='admin@example.com'");
    const denied = await w.authorize({ prompt: 'none' }, signed.cookie);
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
    assert.equal((await w.exchange(signed.code)).status, 400);
    assert.equal((await consoleSession.get('clients')).status, 200);
});

test('a realm admin can sign up for an invited app and a platform admin cannot request or redeem a sign-up link', async t => {
    const w = await signupWorld(t), { db } = w;
    db.exec("INSERT INTO admins VALUES('default','owner@example.com','realm',0,NULL)");
    const signup = await mint(w, { email: 'owner@example.com' });
    assert.equal((await verify(w, signup)).status, 303);
    assert.equal(count(db, 'workspaces'), 1);
    const forbidden = await begin(w);
    assert.equal((await ask(w, forbidden, 'admin@example.com')).status, 202);
    await w.drain();
    assert.equal(w.mails.length, 1);
    db.exec("UPDATE admins SET role='realm' WHERE email='admin@example.com'");
    const inFlight = await mint(w, { email: 'admin@example.com' });
    db.exec("UPDATE admins SET role='platform' WHERE email='admin@example.com'");
    assert.match(await (await verify(w, inFlight)).text(), platformPage);
    assert.equal(count(db, 'workspaces'), 1);
    assert.equal(count(db, 'users'), 1);
});
