// /account: profile, sessions, apps, browsers, email change, deletion; security notices; admin MFA reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, turnstile, cookieJar, begin } from './support/world.mjs';
import { adminLogin, enrolMfa } from './support/admin.mjs';
import { agentWorld } from './support/agents.mjs';
const jarOf = (...parts) => parts.filter(Boolean).join('; ');
const csrfOf = jar => jar.match(/__Host-vi_csrf=([^;]+)/)[1];
const form = (w, path, body, cookie, headers = {}) => w.call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie, ...headers }, body: new URLSearchParams(body) });
async function signedIn(w, t, email) {
    const { flow, cookie, code } = await login(w, t, email);
    return { jar: jarOf(flow.cookie, cookie), code };
}
test('the account page shows profile, security, sessions, apps and agents; the name reaches the profile claims', async t => {
    const w = await world(t);
    const { jar, code } = await signedIn(w, t);
    await w.exchange(code);
    const html = await (await w.call('/account', { headers: { cookie: jar } })).text();
    for (const heading of ['Profile', 'Security', 'Signed-in sessions', 'Apps', 'Connected agents', 'Delete account']) assert.ok(html.includes(`>${heading}</h2>`), heading);
    assert.equal((await form(w, '/account/profile', { csrf: csrfOf(jar), display_name: '  Ada ‮Lovelace  ' }, jar)).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT display_name FROM users').get().display_name, 'Ada Lovelace');
    const next = await (await w.exchange(new URL((await w.authorize({ scope: 'openid profile' }, jar)).headers.get('location')).searchParams.get('code'))).json();
    assert.equal(JSON.parse(Buffer.from(next.id_token.split('.')[1], 'base64url')).name, 'Ada Lovelace');
    assert.equal((await (await w.call('/userinfo', { headers: { authorization: `Bearer ${next.access_token}` } })).json()).name, 'Ada Lovelace');
    assert.equal((await form(w, '/account/profile', { display_name: 'x' }, jar)).status, 403, 'CSRF required');
});
test('a person signs out another session or one app; each sends back-channel logout', async t => {
    const w = await world(t); w.env.LOGOUT_QUEUE = { async send() {} };
    const first = await signedIn(w, t), second = await signedIn(w, t);
    await w.exchange(second.code);
    const otherSid = w.env.DB.db.prepare('SELECT sid FROM app_sessions').get().sid;
    const mine = w.env.DB.db.prepare('SELECT sid FROM sessions WHERE sid<>?').get(otherSid).sid;
    assert.equal((await form(w, '/account/sessions', { csrf: csrfOf(first.jar), sid: mine }, first.jar)).status, 400, 'not this browser');
    assert.equal((await form(w, '/account/sessions', { csrf: csrfOf(first.jar), sid: otherSid }, first.jar)).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions WHERE sid=?').get(otherSid).n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM logout_outbox WHERE sid=?').get(otherSid).n, 1);
    await w.exchange((await signedIn(w, t)).code);
    assert.equal((await form(w, '/account/apps', { csrf: csrfOf(first.jar), client_id: 'app' }, first.jar)).status, 200);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM app_sessions WHERE client_id='app'").get().n, 0);
});
test('email change needs a fresh email link, a confirmation from the new address in the same browser, and tells the old one', async t => {
    const w = await world(t);
    const { jar } = await signedIn(w, t);
    w.env.DB.db.exec("INSERT INTO users(id,realm_id,email,created) VALUES('taken','default','taken@example.com',0)");
    assert.equal((await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'new@example.com' }, jar)).status, 200);
    await w.drain();
    const link = w.mails.find(m => m.to === 'new@example.com').text.match(/(\/account\/email\/confirm\?token=[A-Za-z0-9_-]+)/)[1];
    assert.ok(w.mails.some(m => m.to === 'person@example.com' && /email change requested/.test(m.subject)));
    const token = new URL(link, w.env.ISSUER).searchParams.get('token');
    assert.equal((await w.call(link, { headers: { cookie: jar } })).status, 200, 'GET only shows a button');
    assert.equal(w.env.DB.db.prepare("SELECT email FROM users WHERE id<>'taken'").get().email, 'person@example.com');
    const otherBrowser = jar.replace(/__Host-vi_browser=[^;]+/, '__Host-vi_browser=' + 'b'.repeat(43));
    assert.equal((await form(w, '/account/email/confirm', { csrf: csrfOf(jar), token }, otherBrowser)).status, 400);
    assert.equal((await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'new@example.com' }, jar)).status, 200);
    await w.drain();
    const fresh = new URL(w.mails.filter(m => m.to === 'new@example.com').at(-1).text.match(/(\/account\/email\/confirm\?token=[A-Za-z0-9_-]+)/)[1], w.env.ISSUER).searchParams.get('token');
    assert.equal((await form(w, '/account/email/confirm', { csrf: csrfOf(jar), token: fresh }, jar)).status, 303);
    assert.equal(w.env.DB.db.prepare("SELECT email FROM users WHERE id<>'taken'").get().email, 'new@example.com');
    await w.drain();
    assert.ok(w.mails.some(m => m.to === 'person@example.com' && /your email was changed/.test(m.subject)));
    assert.equal((await form(w, '/account/email/confirm', { csrf: csrfOf(jar), token: fresh }, jar)).status, 400, 'single use');
    w.env.DB.db.prepare('UPDATE sessions SET auth_time=?').run(Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'later@example.com' }, jar)).status, 403);
});
test('an email change cannot take an address another account holds', async t => {
    const w = await world(t);
    const { jar } = await signedIn(w, t);
    await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'taken@example.com' }, jar);
    await w.drain();
    w.env.DB.db.exec("INSERT INTO users(id,realm_id,email,created) VALUES('taken','default','taken@example.com',0)");
    const token = new URL(w.mails.find(m => m.to === 'taken@example.com').text.match(/(\/account\/email\/confirm\?token=[A-Za-z0-9_-]+)/)[1], w.env.ISSUER).searchParams.get('token');
    assert.equal((await form(w, '/account/email/confirm', { csrf: csrfOf(jar), token }, jar)).status, 409);
});
test('deleting an account needs the typed email, a fresh sign-in and a fresh second factor; it ends everything', async t => {
    const w = await agentWorld(t);
    const { tokens } = await w.grant();
    const jar = w.cookie, csrf = w.csrf;
    assert.equal((await form(w, '/account/delete', { csrf, confirm_email: 'someone@else.com' }, jar)).status, 400);
    const mfa = await enrolMfa(w, jar, csrf);
    w.env.DB.db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now() - 3600000);
    assert.equal((await form(w, '/account/delete', { csrf, confirm_email: 'person@example.com' }, jar)).status, 403);
    w.env.DB.db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now());
    const deleted = await form(w, '/account/delete', { csrf, confirm_email: 'Person@Example.com' }, jar);
    assert.equal(deleted.status, 303);
    assert.match(deleted.headers.getSetCookie().join(), /__Host-vi_session=;/);
    assert.equal(w.env.DB.db.prepare('SELECT status FROM users').get().status, 'deleted');
    for (const table of ['sessions', 'mfa_factors', 'recovery_codes', 'user_passwords']) assert.equal(w.env.DB.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.equal((await w.refresh(tokens.refresh_token)).status, 400);
    assert.ok(mfa.secret);
});
test('a sign-in from a new device sends a notice; the first sign-in ever and a known device do not', async t => {
    const w = await world(t);
    const as = (agent, country) => ({ 'user-agent': agent, 'cf-ipcountry': country });
    const signIn = async headers => {
        turnstile(t);
        const flow = await begin(w);
        await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, flow.cookie, headers);
        await w.drain();
        const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
        await w.post('/v1/auth/magic/verify', { token }, flow.cookie, headers);
        await w.drain();
    };
    const notices = () => w.mails.filter(m => /new sign-in/.test(m.subject)).length;
    await signIn(as('Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605', 'GB'));
    assert.equal(notices(), 0);
    await signIn(as('Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605', 'GB'));
    assert.equal(notices(), 0);
    await signIn(as('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537', 'BR'));
    assert.equal(notices(), 1);
    assert.match(w.mails.find(m => /new sign-in/.test(m.subject)).text, /Chrome on Windows/);
    assert.ok(w.env.DB.db.prepare("SELECT device FROM sessions WHERE device='Chrome on Windows'").get());
});
test('approving an agent emails the person', async t => {
    const w = await agentWorld(t);
    await w.grant();
    await w.drain();
    assert.ok(w.mails.some(m => /an agent was connected/.test(m.subject) && /Example Agent/.test(m.text)));
});
test('an admin MFA reset needs a reason, removes factors, ends sessions and tells the person', async t => {
    const w = await world(t); turnstile(t);
    const person = await signedIn(w, t);
    await enrolMfa(w, person.jar, csrfOf(person.jar));
    const userId = w.env.DB.db.prepare("SELECT id FROM users WHERE email='person@example.com'").get().id;
    const admin = await adminLogin(w);
    assert.equal((await admin.post(`users/${userId}/reset-mfa`, { reason: 'no' })).status, 400);
    const reset = await admin.post(`users/${userId}/reset-mfa`, { reason: 'Lost phone, identity checked by video call' });
    assert.equal(reset.status, 200, await reset.clone().text());
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM mfa_factors WHERE user_id=?').get(userId).n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(userId).n, 0);
    assert.match(w.env.DB.db.prepare("SELECT detail FROM audit WHERE event='admin_mfa_reset'").get().detail, /Lost phone/);
    await w.drain();
    assert.ok(w.mails.some(m => m.to === 'person@example.com' && /two-factor authentication was reset/.test(m.subject)));
});

// Review findings on the account page.
test('review 1: with a second factor, changing the email needs it, so mailbox control alone cannot move the account', async t => {
    const w = await world(t);
    const { jar } = await signedIn(w, t);
    await enrolMfa(w, jar, csrfOf(jar));
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    const refused = await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'attacker@example.com' }, jar);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, 'mfa_required');
    w.env.DB.db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now());
    assert.equal((await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'new@example.com' }, jar)).status, 200);
    await w.drain();
    const token = new URL(w.mails.find(m => m.to === 'new@example.com').text.match(/(\/account\/email\/confirm\?token=[A-Za-z0-9_-]+)/)[1], w.env.ISSUER).searchParams.get('token');
    assert.match(await (await w.call(`/account/email/confirm?token=${token}`, { headers: { cookie: jar } })).text(), /new@example\.com/);
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    assert.equal((await form(w, '/account/email/confirm', { csrf: csrfOf(jar), token }, jar)).status, 403);
});
test('review 2: a realm admin cannot reset, block or delete a platform admin', async t => {
    const w = await world(t); turnstile(t);
    w.env.DB.db.exec("INSERT INTO users(id,realm_id,email,email_verified,created) VALUES('boss','default','boss@example.com',1,0); INSERT INTO admins(realm_id,email,role,created) VALUES('default','boss@example.com','platform',0)");
    w.env.DB.db.exec("UPDATE admins SET role='realm' WHERE email='admin@example.com'");
    const admin = await adminLogin(w);
    assert.equal((await admin.post('users/boss/reset-mfa', { reason: 'attempted takeover' })).status, 403);
    for (const action of ['block', 'delete']) assert.equal((await admin.post(`users/boss/${action}`)).status, 403, action);
    assert.equal(w.env.DB.db.prepare("SELECT status FROM users WHERE id='boss'").get().status, 'active');
});
test('review 3 and 4: a held address gets no email, and email changes are capped', async t => {
    const w = await world(t);
    const { jar } = await signedIn(w, t);
    w.env.DB.db.exec("INSERT INTO users(id,realm_id,email,created) VALUES('taken','default','taken@example.com',0)");
    assert.equal((await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'taken@example.com' }, jar)).status, 200);
    await w.drain();
    assert.ok(!w.mails.some(m => m.to === 'taken@example.com'));
    for (let i = 0; i < 4; i++) await form(w, '/account/email', { csrf: csrfOf(jar), new_email: `n${i}@example.com` }, jar);
    assert.equal((await form(w, '/account/email', { csrf: csrfOf(jar), new_email: 'n9@example.com' }, jar)).status, 429);
});
test('a signed-out visit to the account or second-factor pages gets a page that says how to sign in; POSTs stay JSON', async t => {
    const w = await world(t);
    for (const path of ['/account', '/account/mfa', '/account/password', '/mfa']) {
        const response = await w.call(path);
        assert.equal(response.status, 401, path);
        assert.match(response.headers.get('content-type'), /^text\/html/, path);
        const html = await response.text();
        assert.match(html, /<h1 class="fd-h1">Sign in to see your account<\/h1>/, path);
        assert.match(html, /Your Vibernt account opens from the apps that use it/, path);
        assert.match(html, /<a class="fd-link" href="\/login">sign in here<\/a>/, path);
        assert.ok(!html.includes('<!--identity:'), 'brand markers are filled');
    }
    const post = await w.call('/account/profile', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER }, body: 'display_name=x' });
    assert.equal(post.status, 401);
    assert.equal((await post.json()).error, 'login_required');
    assert.equal((await w.call('/accounting')).status, 404, 'only the account paths');
});
