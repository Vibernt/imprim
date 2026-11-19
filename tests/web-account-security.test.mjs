import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { authenticator } from './support/webauthn.mjs';
import { accountSession, change, checkBoundaries, problem, read } from './support/account-api.mjs';
import { currentStep, fromBase32, totpAt } from '../apps/server/src/auth/totp.mjs';

const browser = '; __Host-vi_browser=' + 'a'.repeat(43);
const mutations = ['mfa/start', 'mfa/confirm', 'mfa/remove', 'mfa/recovery', 'passkeys/options', 'passkeys/register', 'passkeys/remove', 'password'];
const readSecurity = async (w, cookie) => {
    const response = await read(w, 'security', cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
};

test('security routes enforce session, CSRF, Origin, verified email and action-specific freshness', async t => {
    const w = await world(t), { cookie, session, user } = await accountSession(w);
    await checkBoundaries(w, cookie, ['security'], mutations);
    const db = w.env.DB.db;
    for (const path of ['mfa/remove', 'mfa/recovery', 'passkeys/remove']) await problem(await change(w, path, {}, cookie), 403, 'mfa_required');
    await problem(await change(w, 'password', { password: 'weak' }, cookie), 400, 'weak_password');
    await problem(await change(w, 'mfa/confirm', {}, cookie), 400, 'invalid_request');
    await problem(await change(w, 'passkeys/options', {}, cookie), 403, 'browser_binding');
    await problem(await change(w, 'passkeys/register', {}, cookie + browser), 400, 'invalid_grant');
    db.prepare('UPDATE users SET email_verified=0 WHERE id=?').run(user.id);
    assert.equal((await readSecurity(w, cookie)).email_verified, false);
    for (const path of ['mfa/start', 'mfa/confirm', 'mfa/remove', 'mfa/recovery', 'passkeys/options', 'passkeys/register', 'password']) {
        await problem(await change(w, path, {}, cookie + browser), 403, 'access_denied');
    }
    db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(user.id);
    db.prepare('UPDATE sessions SET auth_time=0 WHERE sid=?').run(session.sid);
    for (const path of ['mfa/start', 'passkeys/options', 'password']) {
        await problem(await change(w, path, {}, cookie + browser), 403, 'reauth_required');
    }
});

test('TOTP setup is owned, confirmed once, and recovery codes are only disclosed by a mutation', async t => {
    const w = await world(t), owner = await accountSession(w), stranger = await accountSession(w, 'other@example.com');
    const post = (path, body = {}) => change(w, `mfa/${path}`, body, owner.cookie);
    const started = await post('start');
    assert.equal(started.status, 200);
    assert.equal(started.headers.get('cache-control'), 'no-store');
    const { factor_id, qr, secret } = await started.json();
    assert.match(qr, /^<svg.*<path d=/s);
    const code = await totpAt(fromBase32(secret), currentStep());
    const body = { factor_id, code, name: 'Travel phone' };
    await problem(await change(w, 'mfa/confirm', body, stranger.cookie), 404, 'not_found');
    await problem(await post('confirm', { ...body, code: 'bad' }), 400, 'invalid_grant');
    const confirmation = await Promise.all([post('confirm', body), post('confirm', body)]);
    const [saved, replay] = confirmation.sort((a, b) => a.status - b.status);
    assert.equal(saved.status, 200);
    assert.ok([400, 403, 409].includes(replay.status));
    const { recovery_codes: codes } = await saved.json();
    assert.equal(new Set(codes).size, 10);
    const security = await readSecurity(w, owner.cookie);
    assert.equal(security.factors[0].name, 'Travel phone');
    assert.equal(security.recovery_count, 10);
    for (const secretValue of [...codes, secret, 'sealed_secret']) assert.ok(!JSON.stringify(security).includes(secretValue));
    assert.deepEqual((await readSecurity(w, stranger.cookie)).factors, []);
    w.env.DB.db.prepare('UPDATE sessions SET mfa_at=? WHERE sid=?').run(Date.now(), stranger.session.sid);
    await problem(await change(w, 'mfa/remove', { factor_id }, stranger.cookie), 404, 'not_found');
    await problem(await post('remove', {}), 400, 'invalid_request');
    const changed = await post('recovery');
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get('cache-control'), 'no-store');
    const { recovery_codes: replacements } = await changed.json();
    assert.equal(new Set(replacements).size, 10);
    assert.ok(replacements.every(code => !codes.includes(code)));
    assert.equal((await post('remove', { factor_id })).status, 200);
    assert.equal((await readSecurity(w, owner.cookie)).recovery_count, 0);
    await problem(await post('recovery'), 400, 'invalid_request');
    await w.drain();
});

test('passkeys preserve browser binding, single-use attestation, second-factor freshness and credential ownership', async t => {
    const w = await world(t), owner = await accountSession(w), stranger = await accountSession(w, 'other@example.com');
    const cookie = owner.cookie + browser, db = w.env.DB.db;
    const options = await change(w, 'passkeys/options', {}, cookie);
    assert.equal(options.status, 200);
    const { publicKey } = await options.json();
    const key = await authenticator();
    const attestation = { ...await key.create(publicKey), name: 'Laptop' };
    await problem(await change(w, 'passkeys/register', attestation, owner.cookie), 403, 'browser_binding');
    await problem(await change(w, 'passkeys/register', attestation, cookie.replace('a'.repeat(43), 'b'.repeat(43))), 400, 'invalid_grant');
    await problem(await change(w, 'passkeys/register', attestation, stranger.cookie + browser), 403, 'access_denied');
    const saved = await change(w, 'passkeys/register', attestation, cookie);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).recovery_codes.length, 10);
    await problem(await change(w, 'passkeys/register', attestation, cookie), 400, 'invalid_grant');
    const security = await readSecurity(w, cookie);
    assert.deepEqual(security.passkeys.map(p => [p.id, p.name, p.backup_eligible]), [[key.id, 'Laptop', 1]]);
    assert.equal(security.passkeys[0].public_key, undefined);
    db.prepare('UPDATE sessions SET mfa_at=? WHERE sid=?').run(Date.now(), stranger.session.sid);
    await problem(await change(w, 'passkeys/remove', { id: key.id }, stranger.cookie), 404, 'not_found');
    await problem(await change(w, 'passkeys/remove', { id: {} }, cookie), 400, 'invalid_request');
    db.prepare('UPDATE sessions SET mfa_at=0 WHERE sid=?').run(owner.session.sid);
    for (const [path, data] of [['passkeys/options', {}], ['passkeys/remove', { id: key.id }],
        ['mfa/start', {}], ['mfa/confirm', {}], ['mfa/recovery', {}]]) await problem(await change(w, path, data, cookie), 403, 'mfa_required');
    db.prepare('UPDATE sessions SET mfa_at=? WHERE sid=?').run(Date.now(), owner.session.sid);
    assert.equal((await change(w, 'passkeys/remove', { id: key.id }, cookie)).status, 200);
    assert.equal((await readSecurity(w, cookie)).recovery_count, 0);
    await w.drain();
});

test('JSON password set and change use the existing breach check, proofs and session revocation', async t => {
    const w = await world(t), owner = await accountSession(w), otherSession = await accountSession(w), db = w.env.DB.db;
    const check = t.mock.method(globalThis, 'fetch', async url => {
        assert.match(String(url), /^https:\/\/api\.pwnedpasswords\.com\/range\/[A-F0-9]{5}$/);
        return new Response(`${'0'.repeat(35)}:0`);
    });
    const password = 'correct horse battery staple';
    assert.equal((await readSecurity(w, owner.cookie)).password.updated, null);
    assert.equal((await change(w, 'password', { password }, owner.cookie)).status, 200);
    await problem(await read(w, 'security', otherSession.cookie), 401, 'login_required');
    const current = await accountSession(w, 'person@example.com', 'password');
    assert.equal((await readSecurity(w, current.cookie)).password.current_password_required, true);
    const next = 'a different strong phrase';
    await problem(await change(w, 'password', { current_password: 'wrong', password: next }, current.cookie), 403, 'invalid_grant');
    const attempts = await Promise.all([1, 2].map(() => change(w, 'password', { current_password: password, password: next }, current.cookie)));
    const [saved, conflict] = attempts.sort((a, b) => a.status - b.status);
    assert.equal(saved.status, 200);
    await problem(conflict, 409, 'conflict');
    assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE event='password_changed'").get().n, 1);
    assert.equal(check.mock.callCount(), 3);
    await w.drain();
});
