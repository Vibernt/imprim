import test from 'node:test';
import assert from 'node:assert/strict';
import { login, world, cookieJar, turnstile } from './support/world.mjs';
import { adminLogin, enrolMfa } from './support/admin.mjs';
import { ADMIN_FRESH_MS } from '../apps/server/src/admin/auth.mjs';
import { ADMIN_MFA_MS } from '../apps/server/src/auth/mfa.mjs';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';

const HTML = { accept: 'text/html' };
const PROFILE = '/v1/account/profile';
const csrfOf = cookie => cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
async function refused(response, status, code) {
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'error_description']);
    assert.equal(body.error, code);
    assert.equal(typeof body.error_description, 'string');
}

test('/v1/me reports the existing subject, locale, exact roster role and authentication freshness', async t => {
    const w = await world(t);
    await refused(await w.call('/v1/me', { headers: HTML }), 401, 'login_required');
    const { cookie } = await login(w, t);
    const db = w.env.DB.db;
    const get = async () => {
        const response = await w.call('/v1/me', { headers: { cookie, 'accept-language': 'fr' } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return response.json();
    };
    const person = db.prepare('SELECT id,email FROM users').get(), session = db.prepare('SELECT auth_time FROM sessions').get();
    assert.deepEqual(await get(), {
        sub: person.id, email: person.email, initials: 'PE', locale: 'fr', admin: null, mfa: false,
        fresh_until: session.auth_time * 1000 + ADMIN_FRESH_MS, realm: { id: 'default', display_name: 'Vibernt' }
    });
    db.prepare("INSERT INTO admins(realm_id,email,role,created) VALUES('default',?,'realm',0)").run(person.email);
    assert.equal((await get()).admin, 'realm');
    db.prepare("UPDATE admins SET role='platform' WHERE email=?").run(person.email);
    db.prepare("UPDATE users SET locale='de'").run();
    db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now());
    const platform = await get();
    assert.equal(platform.admin, 'platform');
    assert.equal(platform.locale, 'de');
    assert.equal(platform.mfa, true);
    db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now() - ADMIN_MFA_MS);
    assert.equal((await get()).mfa, false);
    db.prepare("UPDATE users SET status='blocked'").run();
    await refused(await w.call('/v1/me', { headers: { cookie } }), 401, 'login_required');
});

test('catalogues are public, keyed by shipped locale and byte-hashed', async t => {
    const w = await world(t);
    const en = await w.call('/v1/i18n/en.json'), fr = await w.call('/v1/i18n/fr.json');
    assert.deepEqual(await en.json(), {});
    const text = await fr.text(), etag = fr.headers.get('etag');
    assert.equal(JSON.parse(text).Profile, 'Profil');
    assert.equal(etag, `"${await sha256(text)}"`);
    assert.equal(fr.headers.get('cache-control'), 'public, max-age=3600');
    assert.notEqual(etag, en.headers.get('etag'));
    assert.equal((await w.call('/v1/i18n/pt-BR.json')).status, 200);
    for (const tag of [etag, `"different", W/${etag}`, '*']) {
        const response = await w.call('/v1/i18n/fr.json', { headers: { 'if-none-match': tag } });
        assert.equal(response.status, 304);
        assert.equal(response.headers.get('etag'), etag);
        assert.equal(await response.text(), '');
    }
    assert.equal((await w.call('/v1/i18n/fr.json', { headers: { 'if-none-match': en.headers.get('etag') } })).status, 200);
    await refused(await w.call('/v1/i18n/it.json', { headers: HTML }), 404, 'not_found');
});

test('Profile JSON endpoints reject unauthenticated, malformed and cross-origin requests', async t => {
    const w = await world(t), { cookie } = await login(w, t);
    const csrf = csrfOf(cookie);
    const body = { display_name: 'Ada' };
    await refused(await w.call(PROFILE, { headers: HTML }), 401, 'login_required');
    for (const action of ['profile', 'email', 'language', 'delete']) {
        const path = `/v1/account/${action}`;
        await refused(await w.post(path, body), 401, 'login_required');
        await refused(await w.post(path, { ...body, csrf }, cookie), 403, 'csrf');
        await refused(await w.post(path, body, cookie, { 'x-csrf-token': 'wrong' }), 403, 'csrf');
        await refused(await w.post(path, body, cookie, { 'x-csrf-token': csrf, origin: 'https://evil.example' }), 403, 'origin');
    }
    await refused(await w.post(PROFILE, body, cookie.replace(csrf, 'wrong'), { 'x-csrf-token': 'wrong' }), 403, 'csrf');
    for (const [type, value, status] of [
        ['text/plain', '{}', 415], ['application/json', '{', 400], ['application/json', '[]', 400],
        ['application/json', JSON.stringify({ display_name: 'x'.repeat(17000) }), 413],
        ['application/json', JSON.stringify({ display_name: 'x'.repeat(101) }), 400]
    ]) {
        await refused(await w.call(PROFILE, { method: 'POST', headers: { cookie, 'content-type': type,
            'x-csrf-token': csrf, origin: w.env.ISSUER }, body: value }), status, 'invalid_request');
    }
    assert.equal(w.env.DB.db.prepare('SELECT display_name FROM users').get().display_name, null);
    assert.equal((await w.call(PROFILE, { headers: { cookie } })).status, 200);
});

test('Profile JSON writes language and email with the same freshness, browser and single-use checks', async t => {
    const w = await world(t), { cookie, flow } = await login(w, t);
    const jar = [flow.cookie, cookie].join('; '), csrf = csrfOf(jar);
    const post = (action, body, cookies = jar) => w.post(`/v1/account/${action}`, body, cookies, { 'x-csrf-token': csrf });
    assert.deepEqual(await (await post('profile', { display_name: '  Ada ‮Lovelace  ' })).json(), { display_name: 'Ada Lovelace' });
    assert.deepEqual(await (await post('language', { locale: 'fr' })).json(), { locale: 'fr' });
    await refused(await post('language', { locale: 'it' }), 400, 'invalid_request');
    const read = async () => (await w.call(PROFILE, { headers: { cookie: jar } })).json();
    assert.deepEqual(await read(), { email: 'person@example.com', email_verified: true, display_name: 'Ada Lovelace',
        locale: 'fr', languages: [{ id: 'en', label: 'English' }, { id: 'es', label: 'Español' }, { id: 'fr', label: 'Français' },
            { id: 'de', label: 'Deutsch' }, { id: 'pt-BR', label: 'Português (Brasil)' }] });
    await post('language', { locale: '' });
    const body = { new_email: 'updated@example.com' };
    const db = w.env.DB.db;
    db.prepare("UPDATE sessions SET method='password'").run();
    await refused(await post('email', body), 403, 'reauth_required');
    db.prepare("UPDATE sessions SET method='email'").run();
    await refused(await post('email', body, cookie), 403, 'browser_binding');
    await enrolMfa(w, jar, csrf);
    db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now() - 600001);
    await refused(await post('email', body), 403, 'mfa_required');
    const step = await w.call('/account/mfa?verify=1&next=%2Faccount', { headers: { ...HTML, cookie: jar } });
    assert.equal(step.headers.get('location'), '/mfa?next=%2Faccount');
    const external = await w.call('/account/mfa?verify=1&next=https%3A%2F%2Fevil.example', { headers: { cookie: jar } });
    assert.equal(external.headers.get('location'), '/mfa?next=%2Faccount');
    db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now());
    const sent = await post('email', body);
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).title, 'Confirmation link sent');
    await w.drain();
    const token = w.mails.find(item => item.to === body.new_email).text.match(/confirm\?token=([\w-]+)/)[1];
    const confirm = browser => w.call('/account/email/confirm', { method: 'POST', headers: {
        origin: w.env.ISSUER, cookie: browser, 'content-type': 'application/x-www-form-urlencoded'
    }, body: new URLSearchParams({ csrf, token }) });
    assert.equal((await confirm(cookie)).status, 400);
    assert.equal((await confirm(jar)).headers.get('location'), `${w.env.ISSUER}/account?changed=email`);
    assert.equal((await confirm(jar)).status, 400);
    assert.equal((await read()).email, body.new_email);
    const deletion = await post('delete', { confirm_email: body.new_email.toUpperCase() });
    assert.deepEqual(await deletion.json(), { redirect: '/signed-out' });
    assert.equal(deletion.headers.getSetCookie().length, 2);
    await refused(await w.call(PROFILE, { headers: { cookie: jar } }), 401, 'login_required');
    await w.drain();
});

test('admin JSON requires a scoped session, MFA, platform role and fresh header-checked writes', async t => {
    const w = await world(t), person = await login(w, t);
    const path = '/admin/api/clients';
    await refused(await w.call(path, { headers: HTML }), 401, 'login_required');
    await refused(await w.call(path, { headers: { ...HTML, cookie: person.cookie } }), 403, 'admin_required');
    const admin = await adminLogin(w);
    const db = w.env.DB.db;
    db.prepare("UPDATE admins SET role='realm' WHERE email='admin@example.com'").run();
    await refused(await admin.get('keys'), 403, 'admin_required');
    await refused(await w.post(path, { csrf: admin.csrf }, admin.cookie), 403, 'csrf');
    await refused(await admin.post('clients', {}, { origin: 'https://evil.example' }), 403, 'origin');
    db.prepare("UPDATE sessions SET auth_time=? WHERE admin_until IS NOT NULL").run(Math.floor(Date.now() / 1000) - 601);
    await refused(await admin.post('clients'), 403, 'reauth_required');
    assert.equal((await admin.get('clients')).status, 200);
    db.prepare('UPDATE sessions SET mfa_at=0 WHERE admin_until IS NOT NULL').run();
    await refused(await admin.get('clients'), 403, 'mfa_required');
    db.prepare('UPDATE sessions SET admin_until=0 WHERE admin_until IS NOT NULL').run();
    await refused(await admin.get('clients'), 403, 'reauth_required');
});
