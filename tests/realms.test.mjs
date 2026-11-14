// Realm isolation: one deployment, several brands, nothing shared except the database and the sealing secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/server/src/worker.mjs';
import { world, login, turnstile, cookieJar, basic } from './support/world.mjs';
import { adminLogin } from './support/admin.mjs';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';
import { forgetRealms, validateRealmConfig } from '../apps/server/src/realms/realm.mjs';
import { scheduled } from '../apps/server/src/services/maintenance.mjs';
const ACME = 'https://id.acme.test';
async function twoRealms(t) {
    const w = await world(t);
    w.env.DB.db.prepare(`INSERT INTO realms(id,issuer,display_name,config,created) VALUES('acme',?,'Acme',?,0)`)
        .run(ACME, JSON.stringify({ email: { from: 'signin@acme.test' }, turnstile: { site_key: { env: 'TURNSTILE_SITE_KEY' }, secret: { env: 'TURNSTILE_SECRET' } } }));
    w.env.DB.db.prepare(`INSERT INTO clients(id,secret_hash,redirect_uris,signup_policy,sign_in_methods,realm_id) VALUES('acme-app',?,?,'open','["email"]','acme')`)
        .run(await sha256('secret'), JSON.stringify(['https://acme-app.test/callback']));
    forgetRealms(w.env);
    const acme = (path, init = {}) => worker.fetch(new Request(ACME + path, init), w.env, { waitUntil() {} });
    return { w, acme };
}
test('an unknown host is refused before any route runs', async t => {
    const { acme, w } = await twoRealms(t);
    const response = await worker.fetch(new Request('https://id.other.test/.well-known/openid-configuration'), w.env, {});
    assert.equal(response.status, 404);
    assert.equal((await acme('/.well-known/openid-configuration')).status, 200);
});
test('each realm has its own issuer, discovery and signing keys', async t => {
    const { w, acme } = await twoRealms(t);
    const [ours, theirs] = await Promise.all([w.call('/.well-known/openid-configuration'), acme('/.well-known/openid-configuration')].map(async r => (await r).json()));
    assert.equal(ours.issuer, 'https://id.vibernt.ai'); assert.equal(theirs.issuer, ACME);
    assert.equal(theirs.token_endpoint, ACME + '/token');
    const a = (await (await w.call('/.well-known/jwks.json')).json()).keys.map(k => k.kid);
    const b = (await (await acme('/.well-known/jwks.json')).json()).keys.map(k => k.kid);
    assert.equal(a.length, 1); assert.equal(b.length, 1); assert.notEqual(a[0], b[0]);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM signing_keys WHERE realm_id='acme'").get().n, 1);
});
test('a client exists only in its own realm', async t => {
    const { w, acme } = await twoRealms(t);
    const query = new URLSearchParams({ client_id: 'app', redirect_uri: 'https://app.example/callback', response_type: 'code', scope: 'openid', state: 's', nonce: 'n', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
    assert.equal((await acme('/authorize?' + query)).status, 400);
    const token = await acme('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic('app', 'secret') },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x'.repeat(43), redirect_uri: 'https://app.example/callback', code_verifier: 'v'.repeat(43) }) });
    assert.equal(token.status, 401);
    assert.equal((await w.call('/authorize?' + new URLSearchParams({ ...Object.fromEntries(query), client_id: 'acme-app', redirect_uri: 'https://acme-app.test/callback' }))).status, 400);
});
test('a session from one realm is not accepted by another, and the same email is two people', async t => {
    const { w, acme } = await twoRealms(t);
    const { cookie } = await login(w, t);
    assert.equal((await w.call('/signed-in', { headers: { cookie } })).status, 200);
    assert.equal((await acme('/signed-in', { headers: { cookie } })).status, 401);
    turnstile(t);
    const page = await acme('/authorize?' + new URLSearchParams({ client_id: 'acme-app', redirect_uri: 'https://acme-app.test/callback', response_type: 'code', scope: 'openid email', state: 's', nonce: 'n', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' }));
    const jar = cookieJar(page), request_id = (await page.text()).match(/data-request-id="([^"]+)"/)[1];
    t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, action: 'sign_in', hostname: 'id.acme.test' }));
    const pending = [];
    await worker.fetch(new Request(ACME + '/v1/auth/magic/request', { method: 'POST', headers: { 'content-type': 'application/json', origin: ACME, cookie: jar },
        body: JSON.stringify({ request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }) }), w.env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    const mail = w.mails.at(-1);
    assert.equal(mail.from, 'signin@acme.test');
    assert.match(mail.text, /https:\/\/id\.acme\.test\/login#token=/);
    const token = mail.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    // The Acme link cannot be redeemed on the Vibernt host.
    const wrongHost = await w.post('/v1/auth/magic/verify', { token }, jar);
    assert.equal(wrongHost.status, 401);
    const verified = await worker.fetch(new Request(ACME + '/v1/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: ACME, cookie: jar }, body: JSON.stringify({ token }) }), w.env, { waitUntil() {} });
    assert.equal(verified.status, 303);
    assert.ok(new URL(verified.headers.get('location')).searchParams.get('code'));
    const people = w.env.DB.db.prepare("SELECT realm_id FROM users WHERE email='person@example.com' ORDER BY realm_id").all().map(r => r.realm_id);
    assert.deepEqual(people, ['acme', 'default']);
});
test('a realm admin sees only their realm; only platform admins see realms and keys', async t => {
    const { w, acme } = await twoRealms(t); turnstile(t);
    w.env.DB.db.exec("UPDATE admins SET role='realm'");
    const admin = await adminLogin(w);
    const clients = (await (await admin.get('clients')).json()).clients.map(c => c.id);
    assert.deepEqual(clients.sort(), ['app', 'other']);
    assert.equal((await admin.get('clients/acme-app')).status, 404);
    assert.equal((await admin.get('realms')).status, 403);
    assert.equal((await admin.get('keys')).status, 403);
    assert.equal((await admin.post('keys/rotate')).status, 403);
    // The Vibernt admin session is not an admin anywhere else.
    assert.equal((await acme('/admin/api/clients', { headers: { cookie: admin.cookie } })).status, 403);
});
test('a platform admin creates a realm and its first admin; secrets must be env references', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const literal = await admin.post('realms', { id: 'beta', issuer: 'https://id.beta.test', display_name: 'Beta', config: { turnstile: { secret: 'plaintext' } } });
    assert.equal(literal.status, 400);
    const created = await admin.post('realms', { id: 'beta', issuer: 'https://id.beta.test', display_name: 'Beta', config: { email: { from: 'signin@beta.test' }, turnstile: { secret: { env: 'BETA_TURNSTILE_SECRET' } } } });
    assert.equal(created.status, 200, await created.clone().text());
    assert.equal((await admin.post('realms', { id: 'gamma', issuer: 'https://id.beta.test', display_name: 'Dup' })).status, 409);
    assert.equal((await admin.post('realms/beta/admins', { email: 'Ops@Beta.test', role: 'realm' })).status, 200);
    assert.equal(w.env.DB.db.prepare("SELECT role FROM admins WHERE realm_id='beta' AND email='ops@beta.test'").get().role, 'realm');
    assert.equal((await admin.post('realms/default/admins', { email: 'admin@example.com', role: null })).status, 400);
    assert.equal((await worker.fetch(new Request('https://id.beta.test/.well-known/openid-configuration'), w.env, {})).status, 200);
    const audit = w.env.DB.db.prepare("SELECT event FROM audit WHERE event LIKE 'admin_realm%' OR event LIKE 'admin_roster%'").all().map(r => r.event);
    assert.deepEqual(audit, ['admin_realm_create', 'admin_roster_set']);
});
test('realm config refuses unknown fields and literal secrets', () => {
    for (const config of [{ unknown: {} }, { email: { colour: 'x' } }, { providers: { github: { client_secret: 'abc' } } }, { turnstile: { secret: { env: 'lower' } } }, []])
        assert.throws(() => validateRealmConfig(config), error => error.code === 'realm_config', JSON.stringify(config));
    assert.ok(validateRealmConfig({ providers: { google: { client_id: 'id.apps.googleusercontent.com', client_secret: { env: 'ACME_GOOGLE_SECRET' } } } }));
});
test('the scheduled sweep keeps one ring per realm; queue delivery signs as the client realm', async t => {
    const { w, acme } = await twoRealms(t);
    await acme('/.well-known/jwks.json'); await w.call('/.well-known/jwks.json');
    await scheduled(w.env);
    assert.deepEqual(w.env.DB.db.prepare('SELECT realm_id,count(*) n FROM signing_keys GROUP BY realm_id ORDER BY realm_id').all().map(r => [r.realm_id, r.n]), [['acme', 1], ['default', 1]]);
    const { deliverLogout } = await import('../apps/server/src/oidc/backchannel.mjs');
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://acme-app.test/backchannel' WHERE id='acme-app'");
    w.env.DB.db.prepare("INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created) VALUES('e1','acme-app','u','s','x',?)").run(Date.now());
    let claims;
    t.mock.method(globalThis, 'fetch', async (_url, init) => { claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('logout_token').split('.')[1], 'base64url')); return new Response(null, { status: 200 }); });
    await deliverLogout(w.env, { body: { event_id: 'e1' } });
    assert.equal(claims.iss, ACME);
});
test('an admin key revocation clears the JWKS memo the public endpoint serves', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const before = (await (await w.call('/.well-known/jwks.json')).json()).keys.map(k => k.kid);
    assert.equal((await admin.post(`keys/${before[0]}/revoke`)).status, 200);
    const after = (await (await w.call('/.well-known/jwks.json')).json()).keys.map(k => k.kid);
    assert.ok(!after.includes(before[0]));
    assert.equal(after.length, 1);
});
test('scripts/realm.mjs generates SQL that creates a working realm, and refuses literal secrets', async t => {
    const { spawnSync } = await import('node:child_process');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(tmpdir() + '/realm-'), good = dir + '/good.json', bad = dir + '/bad.json';
    writeFileSync(good, JSON.stringify({ id: 'acme', issuer: ACME, display_name: "Acme's", config: { email: { from: 'signin@acme.test' } }, admins: [{ email: 'Ops@Acme.test', role: 'realm' }] }));
    writeFileSync(bad, JSON.stringify({ id: 'acme', issuer: ACME, display_name: 'Acme', config: { providers: { google: { client_secret: 'plain' } } } }));
    const run = file => spawnSync(process.execPath, [new URL('../scripts/realm.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
    const refused = run(bad);
    assert.equal(refused.status, 1); assert.match(refused.stderr, /never a literal/);
    const generated = run(good);
    assert.equal(generated.status, 0, generated.stderr);
    const w = await world(t);
    w.env.DB.db.exec(generated.stdout);
    forgetRealms(w.env);
    const discovery = await worker.fetch(new Request(ACME + '/.well-known/openid-configuration'), w.env, {});
    assert.equal((await discovery.json()).issuer, ACME);
    assert.equal(w.env.DB.db.prepare("SELECT display_name FROM realms WHERE id='acme'").get().display_name, "Acme's");
    assert.equal(w.env.DB.db.prepare("SELECT role FROM admins WHERE realm_id='acme' AND email='ops@acme.test'").get().role, 'realm');
});
