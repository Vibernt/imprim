// Every visible word on people-facing pages and in emails goes through the catalogue. The test language wraps each
// message in ⟦ ⟧; any other word must be data (names, emails, hosts, codes, dates).
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, turnstile, cookieJar } from './support/world.mjs';
import { enrolMfa } from './support/admin.mjs';
import { agentWorld, resource } from './support/agents.mjs';
import { registerPseudo, usePseudo, visibleText, assertTranslated, PSEUDO } from './support/i18n.mjs';
import { composeEmail } from '../apps/server/src/services/email/send.mjs';
import { EMAILS } from '../apps/server/src/services/email/messages.mjs';
import { LANGUAGE_NAMES } from '../apps/server/src/i18n/index.mjs';
import { mint, signupWorld, verify } from './support/signup.mjs';
const DATA = ['Vibernt', 'Imprim', 'Example App', 'Example Agent', 'agent.example', resource, 'person@example.com', 'Test phone', PSEUDO, 'Chrome', 'Read workspace', 'read',
    ...Object.values(LANGUAGE_NAMES), 'GitHub', 'Google', 'BCDF-GHJK', 'Notes'];
test.before(() => { registerPseudo(); });
async function check(w, path, init, where = path) {
    const response = await w.call(path, init), html = await response.text();
    assertTranslated(visibleText(html), DATA, where);
    return { response, html };
}
test('sign-in, result and error pages', async t => {
    const w = await world(t); usePseudo(w); turnstile(t);
    for (const path of ['/login', '/check-email', '/signed-out', '/error', '/device', '/device?user_code=BCDF-GHJK', '/account/security']) await check(w, path, { headers: { accept: 'text/html' } });
    w.env.DB.db.prepare(`UPDATE clients SET sign_in_methods='["email","password","passkey","github","google"]' WHERE id='app'`).run();
    await check(w, '/authorize?' + new URLSearchParams({ client_id: 'app', redirect_uri: 'https://app.example/callback', response_type: 'code', scope: 'openid', state: 's', nonce: 'n', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' }));
});
test('account, second-factor, password and logout pages', async t => {
    const w = await world(t); usePseudo(w); turnstile(t);
    const page = await w.call('/login'), browser = cookieJar(page);
    w.env.DB.db.prepare("INSERT INTO admins(realm_id,email,role,created) VALUES('default','person@example.com','realm',0)").run();
    await w.post('/v1/auth/magic/request', { email: 'person@example.com', turnstile: crypto.randomUUID() }, browser); await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const cookie = cookieJar(await w.post('/v1/auth/magic/verify', { token }, browser)), csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const get = path => check(w, path, { headers: { cookie } });
    for (const path of ['/signed-in', '/account/mfa', '/account/password', '/logout']) await get(path);
    const access = await w.call('/v1/account/sessions', { headers: { cookie } });
    assert.equal(access.status, 200);
    assertTranslated((await access.json()).sessions.find(session => session.current).device, DATA, 'current session device');
    await enrolMfa(w, cookie, csrf);
    for (const path of ['/account/mfa', '/mfa', '/mfa?recovery=1']) await get(path);
    const form = (path, body) => check(w, path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie }, body: new URLSearchParams({ csrf, ...body }) }, `POST ${path}`);
    await form('/account/mfa', { action: 'start' });
    await form('/account/mfa', { action: 'recovery' });
    await form('/account/profile', { display_name: 'Dana' });
    await form('/mfa', { code: '000000' });
    await w.drain();
    for (const mail of w.mails) assertTranslated(`${mail.subject}\n${mail.text}\n${visibleText(mail.html)}`, DATA, `mail ${mail.subject}`);
});
test('agent consent and its results', async t => {
    const w = await agentWorld(t); usePseudo(w);
    const flow = await w.start();
    await check(w, `/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie } });
});
test('the sign-up approval waiting page uses the catalogue for visible copy', async t => {
    const w = await signupWorld(t, { realmSignup: 'approval' });
    usePseudo(w);
    const flow = await mint(w);
    const result = await verify(w, flow);
    assert.equal(result.status, 303);
    const url = new URL(result.headers.get('location'));
    const { response } = await check(w, url.pathname + url.search, { headers: { cookie: flow.cookie } });
    assert.equal(response.status, 200);
    await w.drain();
});
test('every email kind, both parts', async t => {
    const w = await world(t);
    w.env.REALM.branding = { legal_name: 'Vibernt Ltd', support_email: 'help@vibernt.example', privacy_url: 'https://vibernt.example/privacy', terms_url: 'https://vibernt.example/terms' };
    for (const kind of Object.keys(EMAILS)) {
        const mail = await composeEmail(w.env, { kind, to: 'p@example.com', locale: PSEUDO,
            vars: { device: 'Chrome on macOS', place: 'Berlin', time: Date.UTC(2026, 0, 1), reason: 'Lost phone', agent: 'Example Agent', app: 'Example App', client: 'app', workspace: 'team-one', scopes: 'read', name: 'Test phone', email: 'person@example.com', old: 'person@example.com', new: 'person@example.com', inviter: 'person@example.com', product: 'notes', products: 'notes' },
            links: { link: 'https://id.example.com/login#token=abc', agents_url: 'https://id.example.com/account/agents', invitation_url: 'https://app.example/start',
                requests_url: 'https://id.example.com/admin/signups', app_url: 'https://app.example/start' } });
        assertTranslated(`${mail.subject}\n${mail.text}\n${visibleText(mail.html)}`, [...DATA, 'Vibernt Ltd', 'Lost phone', 'team-one', 'read', 'Berlin', 'macOS', 'Thu', 'Jan', 'abc', 'notes'], kind);
    }
});
