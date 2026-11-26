// Passkeys: registration, passwordless sign-in, second factor, and the WebAuthn checks at each step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, begin } from './support/world.mjs';
import { authenticator } from './support/webauthn.mjs';
import { assertFireMarkup } from './support/admin.mjs';
import { addTeam, configureJoin, joinPath } from './support/workspace-join.mjs';
import { decodeCbor } from '../apps/server/src/lib/cbor.mjs';
const jarOf = (...parts) => parts.filter(Boolean).join('; ');
const csrfOf = jar => jar.match(/__Host-vi_csrf=([^;]+)/)[1];
const api = (w, path, body, jar) => w.post(path, body, jar, { 'x-csrf-token': csrfOf(jar) });
async function registered(w, t, { methods = ['email', 'passkey'] } = {}) {
    w.env.DB.db.prepare('UPDATE clients SET sign_in_methods=? WHERE id=?').run(JSON.stringify(methods), 'app');
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie), device = await authenticator();
    const options = await (await api(w, '/account/passkeys/options', {}, jar)).json();
    const response = await api(w, '/account/passkeys/register', { name: 'Laptop', ...await device.create(options.publicKey) }, jar);
    assert.equal(response.status, 200, await response.clone().text());
    return { jar, device };
}
test('CBOR decoding refuses truncation, indefinite lengths, duplicate keys and deep nesting', () => {
    assert.deepEqual(decodeCbor(new Uint8Array([0xa1, 0x01, 0x02]))[0], new Map([[1, 2]]));
    for (const bad of [[0x5f], [0x42, 0x01], [0xa2, 0x01, 0x02, 0x01, 0x03], new Array(20).fill(0x81).concat([0x00])])
        assert.throws(() => decodeCbor(new Uint8Array(bad)));
});
test('a passkey registers, then signs in without a password, counting as a second factor', async t => {
    const w = await world(t);
    const { device } = await registered(w, t);
    const stored = w.env.DB.db.prepare('SELECT * FROM webauthn_credentials').get();
    assert.equal(stored.alg, -7); assert.equal(stored.name, 'Laptop'); assert.equal(stored.id, device.id);
    w.env.DB.db.exec("DELETE FROM sessions; UPDATE clients SET mfa='required' WHERE id='app'");
    const flow = await begin(w);
    const options = await (await w.post('/v1/auth/passkey/options', { request_id: flow.request_id }, flow.cookie)).json();
    assert.deepEqual(options.publicKey.allowCredentials, [], 'discoverable: no account hint before the user picks');
    const signed = await w.post('/v1/auth/passkey/verify', { request_id: flow.request_id, ...await device.get(options.publicKey) }, flow.cookie);
    assert.equal(signed.status, 200, await signed.clone().text());
    const code = new URL((await signed.json()).redirect).searchParams.get('code');
    const claims = JSON.parse(Buffer.from((await (await w.exchange(code)).json()).id_token.split('.')[1], 'base64url'));
    assert.deepEqual(claims.amr.sort(), ['mfa', 'swk', 'user']);
    assert.equal(claims.acr, 'urn:imprim:acr:mfa');
});

test('a verified passkey can start a hosted join for an owner without an app admission', async t => {
    const w = await world(t), db = w.env.DB.db;
    const { device } = await registered(w, t);
    const { id } = db.prepare("SELECT id FROM users WHERE email='person@example.com'").get();
    configureJoin(db, 'other', 'app');
    addTeam(db, 'team', id);
    db.exec("UPDATE clients SET signup_policy='invited' WHERE id='app'; DELETE FROM client_admissions WHERE client_id='app'");
    const flow = await begin(w);
    const options = await (await w.post('/v1/auth/passkey/options', { request_id: flow.request_id }, flow.cookie)).json();
    const response = await w.post('/v1/auth/passkey/verify', await device.get(options.publicKey), flow.cookie);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(new URL((await response.json()).redirect).pathname, joinPath);
    assert.equal(db.prepare("SELECT count(*) AS n FROM client_admissions WHERE client_id='app'").get().n, 0);
});
test('assertions are refused for a wrong origin, no user verification, a reused challenge or a counter that goes back', async t => {
    const w = await world(t);
    const { device } = await registered(w, t);
    const attempt = async (overrides = {}, reuse) => {
        const flow = await begin(w);
        const options = reuse || (await (await w.post('/v1/auth/passkey/options', { request_id: flow.request_id }, flow.cookie)).json()).publicKey;
        return { options, response: await w.post('/v1/auth/passkey/verify', { request_id: flow.request_id, ...await device.get(options, overrides) }, flow.cookie) };
    };
    assert.equal((await attempt({ originOverride: 'https://evil.example' })).response.status, 400);
    assert.equal((await attempt({ uv: false })).response.status, 400);
    const ok = await attempt();
    assert.equal(ok.response.status, 200);
    assert.equal((await attempt({}, ok.options)).response.status, 400, 'challenge is single use');
    assert.equal((await attempt({ counterOverride: 1 })).response.status, 400, 'counter must move forward');
    w.env.DB.db.prepare("UPDATE clients SET sign_in_methods='[\"email\"]' WHERE id='app'").run();
    const flow = await begin(w);
    assert.equal((await w.post('/v1/auth/passkey/options', { request_id: flow.request_id }, flow.cookie)).status, 403, 'the app must offer passkeys');
});
test('registration refuses a wrong origin, RP ID or ceremony, and needs CSRF', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie), device = await authenticator();
    for (const overrides of [{ originOverride: 'https://evil.example' }, { rpOverride: 'evil.example' }, { type: 'webauthn.get' }, { uv: false }]) {
        const options = await (await api(w, '/account/passkeys/options', {}, jar)).json();
        assert.equal((await api(w, '/account/passkeys/register', await device.create(options.publicKey, overrides), jar)).status, 400, JSON.stringify(overrides));
    }
    assert.equal((await w.post('/account/passkeys/options', {}, jar)).status, 403, 'CSRF');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM webauthn_credentials').get().n, 0);
});
test('a passkey works as the second factor, and adding one later needs a fresh second factor', async t => {
    const w = await world(t);
    const { jar, device } = await registered(w, t);
    w.env.DB.db.prepare("UPDATE clients SET mfa='required' WHERE id='app'").run();
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    const page = await w.authorize({}, jar);
    const request_id = new URL(page.headers.get('location'), w.env.ISSUER).searchParams.get('request_id');
    const options = await (await api(w, '/v1/auth/passkey/options', { purpose: 'mfa', request_id }, jar)).json();
    assert.deepEqual(options.publicKey.allowCredentials.map(c => c.id), [device.id]);
    const verified = await api(w, '/v1/auth/passkey/verify', { purpose: 'mfa', ...await device.get(options.publicKey) }, jar);
    assert.equal(verified.status, 200, await verified.clone().text());
    assert.ok(new URL((await verified.json()).redirect).searchParams.get('code'));
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    assert.equal((await api(w, '/account/passkeys/options', {}, jar)).status, 403, 'existing factor must be proven first');
});
test('a credential cannot be used as another person\'s second factor', async t => {
    const w = await world(t);
    const { device } = await registered(w, t);
    const other = await login(w, t, 'other@example.com');
    const jar = jarOf(other.flow.cookie, other.cookie);
    const { authenticator: make } = await import('./support/webauthn.mjs');
    const mine = await make();
    const options = await (await api(w, '/account/passkeys/options', {}, jar)).json();
    await api(w, '/account/passkeys/register', await mine.create(options.publicKey), jar);
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    const mfa = await (await api(w, '/v1/auth/passkey/options', { purpose: 'mfa' }, jar)).json();
    assert.equal((await api(w, '/v1/auth/passkey/verify', { purpose: 'mfa', ...await device.get(mfa.publicKey) }, jar)).status, 400);
});

// Review findings: passkeys.
test('review 1 and 2: a first passkey brings recovery codes; removing the last factor voids them', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie), device = await authenticator();
    const options = await (await api(w, '/account/passkeys/options', {}, jar)).json();
    const added = await (await api(w, '/account/passkeys/register', await device.create(options.publicKey), jar)).json();
    assert.equal(added.recovery_codes.length, 10);
    const old = added.recovery_codes[0];
    const id = w.env.DB.db.prepare('SELECT id FROM webauthn_credentials').get().id;
    const removed = await w.call('/account/passkeys/remove', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie: jar }, body: new URLSearchParams({ csrf: csrfOf(jar), id }) });
    assert.equal(removed.status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM recovery_codes').get().n, 0);
    const again = await (await api(w, '/account/passkeys/options', {}, jar)).json();
    const second = await (await api(w, '/account/passkeys/register', await (await authenticator()).create(again.publicKey), jar)).json();
    assert.equal(second.recovery_codes.length, 10);
    assert.ok(!second.recovery_codes.includes(old));
});
test('review 3 and 4: other attestation formats, trailing data and a missing userHandle are refused', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie), device = await authenticator();
    for (const overrides of [{ fmt: 'packed' }, { trailing: [0xff, 0xff] }]) {
        const options = await (await api(w, '/account/passkeys/options', {}, jar)).json();
        assert.equal((await api(w, '/account/passkeys/register', await device.create(options.publicKey, overrides), jar)).status, 400, JSON.stringify(overrides));
    }
    const { device: good } = await registered(w, t);
    const signIn = await begin(w);
    const opts = await (await w.post('/v1/auth/passkey/options', { request_id: signIn.request_id }, signIn.cookie)).json();
    const { userHandle, ...assertion } = await good.get(opts.publicKey);
    assert.ok(userHandle);
    assert.equal((await w.post('/v1/auth/passkey/verify', { request_id: signIn.request_id, ...assertion }, signIn.cookie)).status, 400);
    assert.equal((await w.post('/v1/auth/passkey/options', { request_id: { x: 1 } }, signIn.cookie)).status, 400);
});
test('the account page lists passkeys with escaped names; the second-factor step wires the passkey button', async t => {
    const w = await world(t);
    const { jar } = await registered(w, t);
    w.env.DB.db.prepare('UPDATE webauthn_credentials SET name=?, backup_eligible=1').run('"><script>alert(1)</script>');
    const id = w.env.DB.db.prepare('SELECT id FROM webauthn_credentials').get().id;
    const overview = await (await w.call('/account/mfa', { headers: { cookie: jar } })).text();
    assertFireMarkup(overview);
    assert.ok(!overview.includes('<script>alert(1)') && overview.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'), 'passkey name is escaped');
    assert.ok(overview.includes(`<form method="post" action="/account/passkeys/remove"><input type="hidden" name="csrf" value="${csrfOf(jar)}"><input type="hidden" name="id" value="${id}">`));
    assert.match(overview, /<span class="fd-badge">Synced<\/span>/);
    w.env.DB.db.prepare("UPDATE clients SET mfa='required' WHERE id='app'").run();
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    const location = new URL((await w.authorize({}, jar)).headers.get('location'), w.env.ISSUER);
    assert.equal(location.pathname, '/mfa');
    const html = await (await w.call(location.pathname + location.search, { headers: { cookie: jar } })).text();
    assertFireMarkup(html);
    assert.ok(html.includes(`<button class="fd-btn" type="button" data-variant="outline" data-size="lg" data-block id="passkey-mfa" data-request-id="${location.searchParams.get('request_id')}" data-next="">`));
    assert.ok(html.includes('<script src="/assets/passkey.js" defer></script>'));
    // Script failures appear in a danger notice that stays hidden until there is one.
    assert.match(html, /<div class="fd-callout" id="message-box" hidden data-tone="danger" role="alert">.*?<p class="fd-callout-body" id="message"><\/p><\/div><\/div>/);
});

test('hosted passkey registration uses a default name and a fresh same-account form can rename it', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie), hardware = await authenticator();
    const options = await (await api(w, '/account/passkeys/options', {}, jar)).json();
    const registered = await api(w, '/account/passkeys/register', await hardware.create(options.publicKey), jar);
    assert.equal(registered.status, 200);
    const { id, name, recovery_codes } = await registered.json();
    assert.equal(name, 'Passkey');
    assert.equal(id, hardware.id);
    assert.equal(recovery_codes.length, 10);
    const db = w.env.DB.db;
    const lookup = db.prepare('SELECT name FROM webauthn_credentials WHERE id=?');
    const rename = (values = {}, headers = {}) => w.call('/account/mfa', { method: 'POST',
        headers: { cookie: jar, origin: w.env.ISSUER, 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ action: 'rename-passkey', csrf: csrfOf(jar), id, name: 'New name', ...values }) });
    assert.equal((await rename({ name: '   ' })).status, 400);
    assert.equal((await rename({ csrf: 'wrong' })).status, 403);
    assert.equal((await rename({}, { origin: 'https://other.example.com' })).status, 403);
    const ownerId = db.prepare('SELECT id FROM users').get().id;
    db.prepare("INSERT INTO users(id,email,email_verified,created) VALUES('another','another@example.com',1,0)").run();
    db.prepare("UPDATE webauthn_credentials SET user_id='another' WHERE id=?").run(id);
    assert.equal((await rename()).status, 404);
    db.prepare('UPDATE webauthn_credentials SET user_id=? WHERE id=?').run(ownerId, id);
    assert.equal(lookup.get(id).name, 'Passkey');
    assert.equal((await rename({ name: ' Work <laptop> ' })).status, 303);
    assert.equal(lookup.get(id).name, 'Work <laptop>');
    const overview = await (await w.call('/account/mfa', { headers: { cookie: jar } })).text();
    assertFireMarkup(overview);
    assert.match(overview, /Work &lt;laptop&gt;/);
    db.exec('UPDATE sessions SET mfa_at=1');
    assert.equal((await rename()).status, 403);
    assert.equal(lookup.get(id).name, 'Work <laptop>');
});

test('the account passkey rename API requires a fresh, same-origin session and a credential in its realm', async t => {
    const w = await world(t), { jar, device } = await registered(w, t);
    const path = '/v1/account/passkeys/rename', db = w.env.DB.db;
    const body = { id: device.id, name: '  Work laptop  ' };
    const rename = (headers = {}, changes = {}) => w.post(path, { ...body, ...changes }, jar, { 'x-csrf-token': csrfOf(jar), ...headers });
    const name = () => db.prepare('SELECT name FROM webauthn_credentials WHERE id=?').get(device.id).name;
    assert.equal((await w.post(path, body)).status, 401);
    assert.equal((await w.call(path, { headers: { cookie: jar } })).status, 404);
    assert.equal((await w.post(path, body, jar)).status, 403);
    assert.equal((await rename({ origin: 'https://other.example.com' })).status, 403);
    assert.equal((await rename({}, { name: '\u202ename' })).status, 400);
    const owner = db.prepare('SELECT user_id FROM webauthn_credentials WHERE id=?').get(device.id).user_id;
    db.exec(`INSERT INTO users(id,email,created) VALUES('other-person','other@example.com',0);
        INSERT INTO realms(id,display_name,created) VALUES('foreign','Foreign',0);`);
    db.prepare(`UPDATE webauthn_credentials SET user_id='other-person' WHERE id=?`).run(device.id);
    assert.equal((await rename()).status, 404);
    db.prepare(`UPDATE webauthn_credentials SET user_id=?,realm_id='foreign' WHERE id=?`).run(owner, device.id);
    assert.equal((await rename()).status, 404);
    db.prepare(`UPDATE webauthn_credentials SET realm_id='default' WHERE id=?`).run(device.id);
    assert.equal(name(), 'Laptop');
    assert.equal((await rename()).status, 200);
    assert.equal(name(), 'Work laptop');
    db.exec('UPDATE sessions SET mfa_at=0');
    assert.equal((await rename({}, { name: 'Unverified edit' })).status, 403);
    assert.equal(name(), 'Work laptop');
});
