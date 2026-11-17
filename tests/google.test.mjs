import test from 'node:test';
import assert from 'node:assert/strict';
import { world, cookieJar } from './support/world.mjs';
import { fakeGoogle, googleCallback } from './support/google.mjs';
import { challengeOf, sha256 } from '../apps/server/src/lib/crypto.mjs';
test('Google code flow binds state, nonce and PKCE, links verified email and emits google amr', async t => {
    const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start();
    w.env.DB.db.exec("INSERT INTO users(id,email,email_verified,created) VALUES('imported','person@example.com',1,0)");
    const row = w.env.DB.db.prepare('SELECT * FROM oauth_states').get();
    assert.equal(row.hash, await sha256(flow.url.searchParams.get('state')));
    assert.equal(row.provider, 'google');
    assert.equal(row.oidc_nonce, flow.url.searchParams.get('nonce'));
    assert.notEqual(row.oidc_nonce, flow.url.searchParams.get('state'));
    assert.equal(flow.url.origin, 'https://accounts.google.com');
    assert.equal(flow.url.searchParams.get('response_type'), 'code');
    assert.equal(flow.url.searchParams.get('scope'), 'openid email');
    assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(flow.url.searchParams.get('code_challenge'), await challengeOf(row.verifier));
    assert.match(flow.response.headers.get('set-cookie'), /__Host-vi_google=.*Path=\/; Secure; SameSite=Lax; Max-Age=600; HttpOnly/);
    const response = await googleCallback(w, flow); assert.equal(response.status, 303);
    const exchange = new URLSearchParams(fake.calls[0].options.body);
    assert.equal(exchange.get('client_id'), 'google-client'); assert.equal(exchange.get('client_secret'), 'google-secret');
    assert.equal(exchange.get('code_verifier'), row.verifier);
    assert.equal(exchange.get('redirect_uri'), w.env.ISSUER + '/login/google/callback');
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    const code = new URL(response.headers.get('location')).searchParams.get('code');
    const tokens = await (await w.exchange(code)).json();
    const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url'));
    assert.equal(claims.sub, 'imported'); assert.deepEqual(claims.amr, ['google']);
    assert.equal(w.env.DB.db.prepare('SELECT provider FROM user_identities').get().provider, 'google');
    assert.equal((await googleCallback(w, flow)).status, 401);
    assert.equal(fake.calls.length, 2);
    const sso = await w.authorize({ prompt: 'none' }, cookieJar(response)); assert.equal(sso.status, 303);
    assert.ok(new URL(sso.headers.get('location')).searchParams.has('code'));
});
for (const [name, claims, header] of [
    ['unverified email', { email_verified: false }], ['string verified', { email_verified: 'true' }],
    ['wrong audience', { aud: 'other' }], ['array audience', { aud: ['google-client'] }], ['wrong issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: 0 }], ['invalid expiry', { exp: '9999999999' }], ['nonce mismatch', { nonce: 'wrong' }],
    ['missing sub', { sub: '' }], ['none algorithm', {}, { alg: 'none' }], ['HS256 algorithm', {}, { alg: 'HS256' }],
    ['hd mismatch', { hd: 'elsewhere.example' }], ['hd missing', { hd: undefined }], ['wrong authorized party', { azp: 'other' }]
]) test(`Google refuses ${name} without creating user or session`, async t => {
    const w = await world(t); w.env.DB.db.exec(`UPDATE clients SET google_hosted_domains='["example.com"]'`);
    const fake = fakeGoogle(t, w, claims, header), flow = await fake.start();
    const response = await googleCallback(w, flow); assert.ok([401,403].includes(response.status), await response.text());
    for (const table of ['users', 'sessions', 'user_identities', 'codes']) assert.equal(w.env.DB.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    assert.equal((await googleCallback(w, flow)).status, 401);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});
for (const kind of ['wrong cookie', 'missing cookie', 'wrong browser', 'expired state', 'cancelled', 'unknown state']) test(`Google refuses ${kind} before network`, async t => {
    const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start();
    if (kind === 'expired state') w.env.DB.db.exec('UPDATE oauth_states SET expires_at=0');
    const jar = kind === 'missing cookie' ? flow.cookie.replace(/; __Host-vi_google=[^;]+/, '')
        : kind === 'wrong cookie' ? flow.cookie.replace(/__Host-vi_google=[^;]+/, '__Host-vi_google=' + 'x'.repeat(43))
        : kind === 'wrong browser' ? flow.cookie.replace(/__Host-vi_browser=[^;]+/, '__Host-vi_browser=' + 'x'.repeat(43)) : flow.cookie;
    const changes = kind === 'cancelled' ? { error: 'access_denied' } : kind === 'unknown state' ? { state: 'z'.repeat(43) } : {};
    assert.ok([401,403].includes((await googleCallback(w, flow, changes, jar)).status));
    assert.equal(fake.calls.length, 0); assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});
for (const kind of ['invited unknown', 'blocked', 'deleted', 'merged', 'admin', 'linked admin', 'linked elsewhere']) test(`Google refuses ${kind} neutrally`, async t => {
    const w = await world(t, kind === 'invited unknown' ? 'invited' : 'open'), fake = fakeGoogle(t, w, kind === 'admin' ? { email: 'admin@example.com' } : {});
    if (['blocked','deleted','merged','linked admin','linked elsewhere'].includes(kind)) {
        w.env.DB.db.prepare('INSERT INTO users(id,email,status,created) VALUES(?,?,?,0)').run('owner', kind === 'linked admin' ? 'admin@example.com' : 'person@example.com', ['blocked','deleted'].includes(kind) ? kind : 'active');
        if (kind === 'merged') w.env.DB.db.exec("UPDATE users SET merged_into='owner'");
        if (kind === 'linked elsewhere') w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('elsewhere','elsewhere@example.com',0)");
        w.env.DB.db.prepare("INSERT INTO user_identities(provider,provider_id,user_id,created) VALUES('google','google-42',?,0)").run(kind === 'linked elsewhere' ? 'elsewhere' : 'owner');
    }
    const response = await googleCallback(w, await fake.start()); assert.equal(response.status, 403);
    assert.equal((await response.json()).error_description, 'Account unavailable.');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    if (kind === 'invited unknown') assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM users').get().n, 0);
});
for (const admission of ['invitation', 'allowlisted domain', 'admitted existing account']) test(`Google invited policy accepts ${admission}`, async t => {
    const w = await world(t, 'invited'), fake = fakeGoogle(t, w, { iss: 'accounts.google.com' });
    if (admission === 'invitation') w.env.DB.db.prepare("INSERT INTO invitations VALUES('app','person@example.com',?)").run(Date.now() + 60000);
    if (admission === 'allowlisted domain') w.env.DB.db.exec(`UPDATE clients SET allowed_domains='["example.com"]'`);
    if (admission === 'admitted existing account') w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('old','person@example.com',0); INSERT INTO client_admissions(user_id,client_id,created) VALUES('old','app',0)");
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
});
test('Google invited policy refuses an existing account the app never admitted (S3)', async t => {
    const w = await world(t, 'invited'), fake = fakeGoogle(t, w, { iss: 'accounts.google.com' });
    w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('old','person@example.com',0)");
    assert.equal((await googleCallback(w, await fake.start())).status, 403);
});
// Google is authoritative for an address only on gmail.com or when its signed hd equals the address's domain (S4).
for (const [name, overrides, status] of [['hd matches', {}, 303], ['no hd', { hd: undefined }, 403], ['other hd', { hd: 'other.example' }, 403], ['gmail.com', { email: 'person@gmail.com', hd: undefined }, 303]])
    test(`Google domain admission and auto-link require an authoritative mailbox: ${name}`, async t => {
        const w = await world(t, 'invited'), fake = fakeGoogle(t, w, { iss: 'accounts.google.com', ...overrides });
        const email = overrides.email || 'person@example.com';
        w.env.DB.db.exec(`UPDATE clients SET allowed_domains='["example.com","gmail.com"]'`);
        w.env.DB.db.prepare("INSERT INTO users(id,email,created) VALUES('old',?,0)").run(email);
        const response = await googleCallback(w, await fake.start());
        assert.equal(response.status, status, await response.clone().text());
        assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM user_identities WHERE user_id='old'").get().n, status === 303 ? 1 : 0);
    });
test('Google subject stays linked when verified email changes to an unclaimed address', async t => {
    const w = await world(t), fake = fakeGoogle(t, w);
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
    const owner = w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id;
    fake.config.overrides = { email: 'changed@example.com' };
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM users').get().n, 1);
    assert.equal(w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id, owner);
});
test('concurrent Google callbacks spend state exactly once', async t => {
    const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start();
    const responses = await Promise.all([googleCallback(w, flow), googleCallback(w, flow)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [303,401]);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 1);
});
test('Google concurrent provider linking cannot overwrite or sign into the winning account', async t => {
    const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start();
    w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('winner','winner@example.com',0)");
    const prepare = w.env.DB.prepare;
    t.mock.method(w.env.DB, 'prepare', (sql, ...args) => {
        if (sql.startsWith('INSERT INTO user_identities')) w.env.DB.db.exec("INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES('google','google-42','winner',NULL,0)");
        return prepare(sql, ...args);
    });
    assert.equal((await googleCallback(w, flow)).status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id, 'winner');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});
for (const kind of ['missing configuration', 'rate limited']) test(`Google refuses ${kind} explicitly`, async t => {
    const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start();
    if (kind === 'missing configuration') delete w.env.GOOGLE_CLIENT_SECRET;
    else w.env.AUTH_LIMITER.limit = async () => ({ success: false });
    assert.equal((await googleCallback(w, flow)).status, kind === 'missing configuration' ? 503 : 429);
    assert.equal(fake.calls.length, 0);
});

test('a Google-only client completes a consumer-account flow without an hd restriction', async t => {
    const w = await world(t); w.env.DB.db.exec(`UPDATE clients SET sign_in_methods='["google"]'`);
    const fake = fakeGoogle(t, w, { hd: undefined });
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT google_hd FROM sessions').get().google_hd, null);
});

test('Google sign-in after merging provider-created source authenticates as survivor', async t => {
    const { changeUser } = await import('../apps/server/src/admin/users.mjs');
    const w = await world(t), fake = fakeGoogle(t, w);
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
    const source = w.env.DB.db.prepare('SELECT * FROM users').get();
    w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('survivor','survivor@example.com',0)");
    await changeUser(w.env, 'operator', source.id, 'merge', 'survivor', source.email);
    const response = await googleCallback(w, await fake.start()); assert.equal(response.status, 303);
    const tokens = await (await w.exchange(new URL(response.headers.get('location')).searchParams.get('code'))).json();
    assert.equal(JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url')).sub, 'survivor');
});
