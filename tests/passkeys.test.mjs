// Passkeys: registration, passwordless sign-in, second factor, and the WebAuthn checks at each step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, begin } from './support/world.mjs';
import { authenticator } from './support/webauthn.mjs';
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
