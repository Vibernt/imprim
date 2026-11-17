import test from 'node:test';
import assert from 'node:assert/strict';
import { world, begin, login, cookieJar, turnstile, basic } from './support/world.mjs';
const count = (w, table) => w.env.DB.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
async function request(w, flow, email = 'person@example.com', challenge = crypto.randomUUID()) {
    const response = await w.post('/v1/auth/magic/request', { email, request_id: flow.request_id, turnstile: challenge }, flow.cookie);
    await w.drain(); return response;
}
const tokenOf = w => w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
test('magic replay refused; session and CSRF stored hashed with host-only cookies', async t => {
    const w = await world(t), signed = await login(w, t);
    assert.equal((await w.post('/v1/auth/magic/verify', { token: signed.token }, signed.flow.cookie)).status, 401);
    const row = w.env.DB.db.prepare('SELECT * FROM sessions').get();
    const jar = Object.fromEntries(signed.cookie.split('; ').map(c => c.split('=')));
    assert.notEqual(row.hash, jar['__Host-vi_session']);
    assert.notEqual(row.csrf_hash, jar['__Host-vi_csrf']);
    assert.ok(row.expires_at > Date.now() + 29 * 86400000);
    for (const c of signed.response.headers.getSetCookie()) {
        assert.match(c, /Path=\/; Secure; SameSite=Lax; Max-Age=2592000/);
        assert.ok(!c.includes('Domain='));
    }
});
test('magic from another browser cannot complete or consume original request', async t => {
    const w = await world(t); turnstile(t);
    const first = await begin(w), second = await begin(w);
    await request(w, first);
    const token = tokenOf(w);
    assert.equal((await w.post('/v1/auth/magic/verify', { token }, second.cookie)).status, 401);
    assert.equal(count(w, 'codes'), 0);
    assert.equal((await w.post('/v1/auth/magic/verify', { token }, first.cookie)).status, 303);
});
for (const status of ['blocked', 'deleted']) test(`${status} users get neutral request and cannot verify an outstanding link`, async t => {
    const w = await world(t); turnstile(t); const flow = await begin(w);
    await request(w, flow); const token = tokenOf(w);
    await w.env.DB.prepare('INSERT INTO users(id,email,status,created) VALUES(?,?,?,?)').bind('u', 'person@example.com', status, Date.now()).run();
    assert.equal((await w.post('/v1/auth/magic/verify', { token }, flow.cookie)).status, 403);
    assert.equal((await request(w, flow)).status, 200);
    assert.equal(w.mails.length, 1);
    assert.equal(count(w, 'sessions'), 0);
});
test('invited policy neutral refusal; invite is client-scoped and expires', async t => {
    const w = await world(t, 'invited'); turnstile(t); const flow = await begin(w);
    assert.deepEqual(await (await request(w, flow)).json(), { accepted: true });
    assert.equal(w.mails.length, 0);
    assert.equal((await w.post('/v1/invitations', { email: 'person@example.com' }, '', { authorization: basic('other') })).status, 201);
    await request(w, flow); assert.equal(w.mails.length, 0);
    await w.post('/v1/invitations', { email: 'Person@example.com' }, '', { authorization: basic() });
    await request(w, flow); assert.equal(w.mails.length, 1);
    w.env.DB.db.exec('UPDATE invitations SET expires_at=0');
    assert.equal((await w.post('/v1/auth/magic/verify', { token: tokenOf(w) }, flow.cookie)).status, 403);
});
for (const kind of ['admitted existing', 'domain']) test(`invited policy admits ${kind}`, async t => {
    const w = await world(t, 'invited'); turnstile(t);
    if (kind === 'admitted existing') w.env.DB.db.exec("INSERT INTO users(id,email,email_verified,created) VALUES('existing','person@example.com',1,0); INSERT INTO client_admissions(user_id,client_id,created) VALUES('existing','app',0)");
    else w.env.DB.db.exec(`UPDATE clients SET allowed_domains='["example.com"]'`);
    const flow = await begin(w); await request(w, flow);
    assert.equal(w.mails.length, 1);
    assert.equal((await w.post('/v1/auth/magic/verify', { token: tokenOf(w) }, flow.cookie)).status, 303);
});
test('an account that exists for another app is not admitted to an invited app (S3)', async t => {
    const w = await world(t, 'invited'); turnstile(t);
    w.env.DB.db.exec("INSERT INTO users(id,email,email_verified,created) VALUES('existing','person@example.com',1,0); INSERT INTO client_admissions(user_id,client_id,created) VALUES('existing','other',0)");
    const flow = await begin(w); await request(w, flow);
    assert.equal(w.mails.length, 0);
});
test('an identity session from an open app cannot reach an invited app by SSO (S3)', async t => {
    const w = await world(t, 'invited');
    w.env.DB.db.exec("UPDATE clients SET signup_policy='open' WHERE id='other'");
    const flow = await begin(w);
    turnstile(t);
    const other = await w.call('/authorize?' + new URLSearchParams({ client_id: 'other', redirect_uri: 'https://app.example/callback', response_type: 'code', scope: 'openid email', state: 's', nonce: 'n', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' }), { headers: { cookie: flow.cookie } });
    const otherId = (await other.text()).match(/data-request-id="([^"]+)"/)[1];
    await request(w, { ...flow, request_id: otherId });
    const signed = await w.post('/v1/auth/magic/verify', { token: tokenOf(w) }, flow.cookie);
    assert.equal(signed.status, 303);
    const jar = [flow.cookie, cookieJar(signed)].join('; ');
    const sso = await w.authorize({}, jar);
    assert.equal(sso.status, 303);
    const location = new URL(sso.headers.get('location'));
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('code'), null);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM client_admissions WHERE client_id='app'").get().n, 0);
    // prompt=none gets the same OAuth error, never an HTML page.
    const silent = await w.authorize({ prompt: 'none' }, jar);
    assert.equal(new URL(silent.headers.get('location')).searchParams.get('error'), 'access_denied');
    // An invitation then admits the same session without a new sign-in.
    w.env.DB.db.prepare("INSERT INTO invitations VALUES('app','person@example.com',?)").run(Date.now() + 60000);
    const invited = await w.authorize({}, jar);
    assert.ok(new URL(invited.headers.get('location')).searchParams.get('code'));
});
test('a code for an app whose admission vanished cannot be exchanged (S3 fence at /token)', async t => {
    const w = await world(t, 'invited'); turnstile(t);
    w.env.DB.db.prepare("INSERT INTO invitations VALUES('app','person@example.com',?)").run(Date.now() + 60000);
    const { code } = await login(w, t);
    w.env.DB.db.exec("DELETE FROM client_admissions");
    assert.equal((await w.exchange(code)).status, 400);
});
test('allowlisted domain matches exactly, never a suffix', async t => {
    const w = await world(t, 'invited'); turnstile(t);
    w.env.DB.db.exec(`UPDATE clients SET allowed_domains='["example.com"]'`);
    await request(w, await begin(w), 'person@evil-example.com');
    assert.equal(w.mails.length, 0);
});
for (const phase of ['request', 'verify']) for (const origin of ['', 'https://evil.example']) test(`${phase} refuses missing/foreign Origin: ${origin}`, async t => {
    const w = await world(t); turnstile(t); const flow = await begin(w);
    await request(w, flow);
    const response = await w.post(`/v1/auth/magic/${phase}`, { email: 'person@example.com', request_id: flow.request_id, token: tokenOf(w), turnstile: 'new-token' }, flow.cookie, { origin });
    assert.equal(response.status, 403);
});
test('expired magic link and request refuse', async t => {
    const w = await world(t); turnstile(t); const flow = await begin(w);
    await request(w, flow); w.env.DB.db.exec('UPDATE magic_links SET expires_at=0');
    assert.equal((await w.post('/v1/auth/magic/verify', { token: tokenOf(w) }, flow.cookie)).status, 401);
    w.env.DB.db.exec('UPDATE auth_requests SET expires_at=0');
    assert.equal((await request(w, flow)).status, 403);
});
test('email delivery failure removes link and audits; neutral public response survives', async t => {
    const w = await world(t); turnstile(t); const flow = await begin(w);
    w.env.EMAIL.send = async () => { throw new Error('provider failed'); };
    assert.deepEqual(await (await request(w, flow)).json(), { accepted: true });
    assert.equal(count(w, 'magic_links'), 0);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='magic_delivery_failed'").get().n, 1);
});
test('operator can bootstrap email sign-in with zero registered clients', async t => {
    const w = await world(t); turnstile(t); w.env.DB.db.exec('DELETE FROM clients');
    const page = await w.call('/login'), cookie = cookieJar(page);
    await w.post('/v1/auth/magic/request', { email: 'admin@example.com', turnstile: 'operator-challenge' }, cookie);
    await w.drain();
    const response = await w.post('/v1/auth/magic/verify', { token: tokenOf(w), browser_response: true }, cookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).redirect, w.env.ISSUER + '/signed-in');
    assert.equal((await w.call('/signed-in', { headers: { cookie: cookieJar(response) } })).status, 200);
});
test('browser JSON completion carries cookies and redirect without cross-origin fetch', async t => {
    const w = await world(t); turnstile(t); const flow = await begin(w);
    await request(w, flow);
    const response = await w.post('/v1/auth/magic/verify', { token: tokenOf(w), browser_response: true }, flow.cookie);
    assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 2);
    assert.equal(new URL((await response.json()).redirect).origin, 'https://app.example');
});
