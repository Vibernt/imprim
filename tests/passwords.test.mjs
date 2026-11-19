// Passwords: set through mailbox proof, sign-in without enumeration, lockout, breach check, change and reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { world, begin, cookieJar } from './support/world.mjs';
import { addTeam, configureJoin, joinPath } from './support/workspace-join.mjs';
import { PASSWORD_FAILURE_LIMIT } from '../apps/server/src/auth/rate-limit.mjs';
const GOOD = 'correct horse battery staple', BREACHED = 'password1234567';
const sha1 = value => createHash('sha1').update(value).digest('hex').toUpperCase();
function network(t, state = { hibp: 'ok', calls: [] }) {
    t.mock.method(globalThis, 'fetch', async url => {
        url = String(url); state.calls.push(url);
        if (url.includes('challenges.cloudflare.com')) return Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' });
        if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
            if (state.hibp === 'down') throw new TypeError('network');
            if (state.hibp === '503') return new Response('', { status: 503 });
            const breached = sha1(BREACHED);
            return new Response(`${'0'.repeat(35)}:0\r\n${url.endsWith(breached.slice(0, 5)) ? breached.slice(5) + ':42' : 'ABC:1'}`);
        }
        throw new Error('Unexpected network request: ' + url);
    });
    return state;
}
async function passwordWorld(t, methods = ['email', 'password']) {
    const w = await world(t, 'open'), net = network(t);
    w.env.DB.db.prepare("UPDATE clients SET sign_in_methods=? WHERE id='app'").run(JSON.stringify(methods));
    return { w, net };
}
const form = (w, path, body, cookie) => w.call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie }, body: new URLSearchParams(body) });
// Email link with purpose 'password' → set-password page → new password → back to the app with a code.
async function setPassword(w, password = GOOD, email = 'person@example.com') {
    const flow = await begin(w);
    assert.equal((await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email, purpose: 'password', turnstile: crypto.randomUUID() }, flow.cookie)).status, 200);
    await w.drain();
    assert.match(w.mails.at(-1).subject, /^Set your password for/);
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const verified = await w.post('/v1/auth/magic/verify', { token }, flow.cookie);
    assert.equal(verified.status, 303);
    assert.match(verified.headers.get('location'), /\/account\/password\?request_id=/);
    const jar = [flow.cookie, cookieJar(verified)].join('; ');
    const csrf = jar.match(/__Host-vi_csrf=([^;]+)/)[1];
    const saved = await form(w, '/account/password', { csrf, request_id: flow.request_id, password }, jar);
    return { flow, jar, csrf, saved };
}
const signIn = async (w, password = GOOD, email = 'person@example.com', extra = {}) => {
    const flow = await begin(w);
    return { flow, response: await w.post('/v1/auth/password', { request_id: flow.request_id, email, password, turnstile: crypto.randomUUID(), ...extra }, flow.cookie) };
};

test('a correct password can start a hosted join for an owner without an app admission', async t => {
    const { w } = await passwordWorld(t), db = w.env.DB.db;
    assert.equal((await setPassword(w)).saved.status, 303);
    configureJoin(db, 'other', 'app');
    const { id } = db.prepare("SELECT id FROM users WHERE email='person@example.com'").get();
    addTeam(db, 'team', id);
    db.exec("UPDATE clients SET signup_policy='invited' WHERE id='app'; DELETE FROM client_admissions WHERE client_id='app'");
    assert.equal((await signIn(w, 'wrong password')).response.status, 401);
    const { response } = await signIn(w);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(new URL((await response.json()).redirect).pathname, joinPath);
    assert.equal(db.prepare("SELECT count(*) AS n FROM client_admissions WHERE client_id='app'").get().n, 0);
});

test('a password is set only after an email link proves the mailbox, then sign-in continues to the app as pwd', async t => {
    const { w } = await passwordWorld(t);
    const { saved } = await setPassword(w);
    assert.equal(saved.status, 303, await saved.clone().text());
    const code = new URL(saved.headers.get('location')).searchParams.get('code');
    const tokens = await (await w.exchange(code)).json();
    assert.deepEqual(JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url')).amr, ['pwd']);
    const row = w.env.DB.db.prepare('SELECT * FROM user_passwords').get();
    assert.equal(row.algorithm, 'pbkdf2-sha256'); assert.equal(row.iterations, 100000);
    assert.ok(!JSON.stringify(row).includes(GOOD));
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='password_set'").get().n, 1);
});
test('password sign-in succeeds; wrong password, unknown email and no password give the same answer', async t => {
    const { w } = await passwordWorld(t);
    await setPassword(w);
    const ok = await signIn(w);
    assert.equal(ok.response.status, 200, await ok.response.clone().text());
    assert.ok(new URL((await ok.response.json()).redirect).searchParams.get('code'));
    w.env.DB.db.exec("INSERT INTO users(id,realm_id,email,email_verified,created) VALUES('nopw','default','nopw@example.com',1,0)");
    const answers = [];
    for (const [password, email] of [['wrong password here', 'person@example.com'], [GOOD, 'nobody@example.com'], [GOOD, 'nopw@example.com']]) {
        const { response } = await signIn(w, password, email);
        answers.push([response.status, (await response.json()).error_description]);
    }
    assert.deepEqual(answers, Array(3).fill([401, 'Email or password is incorrect.']));
});
test('password sign-in is refused where the app does not offer it, from another origin, or without a request', async t => {
    const { w } = await passwordWorld(t, ['email']);
    assert.equal((await signIn(w)).response.status, 403);
    const flow = await begin(w);
    assert.equal((await w.post('/v1/auth/password', { request_id: flow.request_id, email: 'a@example.com', password: GOOD }, flow.cookie, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await w.post('/v1/auth/password', { email: 'a@example.com', password: GOOD }, flow.cookie)).status, 400);
    assert.equal((await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'a@example.com', purpose: 'password', turnstile: 'x' }, flow.cookie)).status, 403);
});
test('ten failures lock the account for everyone, including for unknown emails; a success clears the count', async t => {
    const { w } = await passwordWorld(t);
    await setPassword(w);
    for (let i = 0; i < PASSWORD_FAILURE_LIMIT - 1; i++) assert.equal((await signIn(w, 'wrong password here')).response.status, 401);
    assert.equal((await signIn(w)).response.status, 200, 'success before the limit');
    for (let i = 0; i < PASSWORD_FAILURE_LIMIT; i++) await signIn(w, 'wrong password here');
    const locked = await signIn(w);
    assert.equal(locked.response.status, 429);
    for (let i = 0; i < PASSWORD_FAILURE_LIMIT; i++) await signIn(w, GOOD, 'ghost@example.com');
    assert.equal((await signIn(w, GOOD, 'ghost@example.com')).response.status, 429, 'locking reveals nothing about existence');
});
test('breached and weak passwords are refused; if the breach check is down, no password is stored', async t => {
    const { w, net } = await passwordWorld(t);
    const breached = await setPassword(w, BREACHED);
    assert.equal(breached.saved.status, 400);
    assert.match(await breached.saved.text(), /data breach/);
    assert.ok(net.calls.some(url => url === `https://api.pwnedpasswords.com/range/${sha1(BREACHED).slice(0, 5)}`));
    assert.ok(!net.calls.some(url => url.includes(sha1(BREACHED).slice(5))), 'only the five-character prefix leaves the Worker');
    // Each case uses its own address: one recipient gets at most five links an hour (S8).
    for (const [i, weak] of ['short', 'weak1@example.com', 'aaaaaaaaaaaaaaaa'].entries()) {
        const { saved } = await setPassword(w, weak, `weak${i}@example.com`);
        assert.equal(saved.status, 400, weak);
    }
    for (const mode of ['down', '503']) {
        net.hibp = mode;
        const { saved } = await setPassword(w, GOOD, `${mode}@example.com`);
        assert.equal(saved.status, 503, mode);
    }
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM user_passwords').get().n, 0);
});
test('changing a password needs the current one unless the session is fresh from an email link; it ends other sessions and notifies', async t => {
    const { w } = await passwordWorld(t);
    await setPassword(w);
    const other = await signIn(w);
    const otherJar = [other.flow.cookie, cookieJar(other.response)].join('; ');
    const user = w.env.DB.db.prepare('SELECT id FROM users').get().id;
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(user).n, 2);
    const csrf = otherJar.match(/__Host-vi_csrf=([^;]+)/)[1];
    const missing = await form(w, '/account/password', { csrf, password: 'another long passphrase' }, otherJar);
    assert.equal(missing.status, 403);
    const wrong = await form(w, '/account/password', { csrf, current_password: 'not it at all', password: 'another long passphrase' }, otherJar);
    assert.equal(wrong.status, 403);
    // A reset through a fresh email link needs no current password and signs out every other session.
    const reset = await setPassword(w, 'a completely new passphrase');
    assert.equal(reset.saved.status, 303);
    await w.drain();
    assert.ok(w.mails.some(mail => /your password was changed/.test(mail.subject)));
    assert.equal((await w.call('/account/password', { headers: { cookie: otherJar } })).status, 401, 'the other session ended');
    assert.equal((await signIn(w, GOOD)).response.status, 401);
    assert.equal((await signIn(w, 'a completely new passphrase')).response.status, 200);
});
test('an unverified account cannot set a password, and mailbox proof removes any password', async t => {
    const { w } = await passwordWorld(t);
    const { issueSession } = await import('../apps/server/src/auth/session.mjs');
    w.env.DB.db.exec("INSERT INTO users(id,realm_id,email,email_verified,created) VALUES('u1','default','person@example.com',0,0)");
    const signed = await issueSession(w.env, w.env.DB.db.prepare("SELECT * FROM users WHERE id='u1'").get(), 'github');
    const jar = signed.cookies.map(c => c.split(';')[0]).join('; ');
    assert.equal((await w.call('/account/password', { headers: { cookie: jar } })).status, 403);
    w.env.DB.db.prepare("INSERT INTO user_passwords VALUES('u1','pbkdf2-sha256',100000,'c2FsdA','aGFzaA',0,0)").run();
    const { claimMailbox } = await import('../apps/server/src/services/access.mjs');
    await claimMailbox(w.env, w.env.DB.db.prepare("SELECT * FROM users WHERE id='u1'").get());
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM user_passwords').get().n, 0);
});
test('administrator addresses cannot sign in with a password', async t => {
    const { w } = await passwordWorld(t);
    w.env.DB.db.exec("INSERT INTO users(id,realm_id,email,email_verified,created) VALUES('adm','default','admin@example.com',1,0)");
    const { hashPassword } = await import('../apps/server/src/auth/password-hash.mjs');
    const h = await hashPassword(GOOD);
    w.env.DB.db.prepare("INSERT INTO user_passwords VALUES('adm',?,?,?,?,0,0)").run(h.algorithm, h.iterations, h.salt, h.hash);
    assert.equal((await signIn(w, GOOD, 'admin@example.com')).response.status, 401);
});
test('the sign-in page offers password, link and set-password actions only where the app allows them', async t => {
    const { w } = await passwordWorld(t);
    const html = await (await w.authorize()).text();
    for (const id of ['password-sign-in', 'send-link', 'set-password']) assert.ok(html.includes(`id="${id}"`), id);
    w.env.DB.db.prepare("UPDATE clients SET sign_in_methods='[\"password\"]' WHERE id='app'").run();
    const only = await (await w.authorize()).text();
    assert.ok(only.includes('id="password-sign-in"') && only.includes('id="set-password"') && !only.includes('id="send-link"'));
});

// Review findings: password.
test('review 1: a parallel burst of guesses cannot pass the account limit', async t => {
    const { w } = await passwordWorld(t);
    await setPassword(w);
    const flows = await Promise.all(Array.from({ length: 40 }, () => begin(w)));
    const statuses = await Promise.all(flows.map(flow => w.post('/v1/auth/password', { request_id: flow.request_id, email: 'person@example.com', password: 'wrong password here', turnstile: crypto.randomUUID() }, flow.cookie).then(r => r.status)));
    assert.equal(statuses.filter(s => s === 401).length, PASSWORD_FAILURE_LIMIT);
    assert.equal(statuses.filter(s => s === 429).length, 40 - PASSWORD_FAILURE_LIMIT);
    assert.equal((await signIn(w)).response.status, 429, 'locked even for the right password');
});
test('review 2: a reset signs whoever else is signed in out of every app by back-channel', async t => {
    const { w } = await passwordWorld(t);
    w.env.LOGOUT_QUEUE = { async send() {} };
    await setPassword(w);
    const other = await signIn(w);
    const code = new URL((await other.response.json()).redirect).searchParams.get('code');
    assert.equal((await w.exchange(code)).status, 200);
    const sid = w.env.DB.db.prepare('SELECT sid FROM app_sessions').get().sid;
    await setPassword(w, 'a completely new passphrase');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM app_sessions WHERE sid=?').get(sid).n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM logout_outbox WHERE sid=?').get(sid).n, 1);
});
test('review 3: a newcomer admitted by allowed_domains sets a password and stays admitted', async t => {
    const w = await world(t, 'invited'); network(t);
    w.env.DB.db.exec(`UPDATE clients SET sign_in_methods='["password"]', allowed_domains='["example.com"]' WHERE id='app'`);
    const { saved } = await setPassword(w);
    assert.equal(saved.status, 303, await saved.clone().text());
    assert.ok(new URL(saved.headers.get('location')).searchParams.get('code'));
    assert.equal((await signIn(w)).response.status, 200);
});
test('review 4: a provider session cannot set a first password without a fresh email link', async t => {
    const { w } = await passwordWorld(t);
    const { issueSession } = await import('../apps/server/src/auth/session.mjs');
    const { ensureUser } = await import('../apps/server/src/services/admission.mjs');
    const signed = await issueSession(w.env, await ensureUser(w.env, 'person@example.com'), 'github');
    const jar = signed.cookies.map(c => c.split(';')[0]).join('; ');
    const saved = await form(w, '/account/password', { csrf: jar.match(/__Host-vi_csrf=([^;]+)/)[1], password: GOOD }, jar);
    assert.equal(saved.status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM user_passwords').get().n, 0);
});
