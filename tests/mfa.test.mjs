// Two-factor authentication: QR and TOTP correctness, policy, step-up, recovery, trusted browsers, admins, agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { world, login, turnstile, cookieJar, begin } from './support/world.mjs';
import { enrolMfa, assertFireMarkup } from './support/admin.mjs';
import { qrMatrix } from '../apps/server/src/lib/qr.mjs';
import { totpAt, fromBase32, base32, currentStep } from '../apps/server/src/auth/totp.mjs';
import { agentWorld } from './support/agents.mjs';

test('QR matrices equal qrencode 4.x output for the same text (level M, versions 1-10)', () => {
    // Fingerprints of `qrencode -8 -l M -m 0 -t ASCII`, with the mask qrencode chose.
    const vectors = [['A', 4, '61abe46a715ded835c51446cd58ca00a085e94c5f73b384a31e5ec37e38dd88d'], ['hello', 7, 'fa33978414ee2a6ced862c61c54766a2bdb32efa554ad0e0dbe43fb3244c27db'],
        ['https://id.example.com', 0, '069d3e95eeebb2ec4ae33705dbced66943f1fa300cd1fa3015f33fc1475224c8'],
        ['otpauth://totp/Vibernt:person%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Vibernt&algorithm=SHA1&digits=6&period=30', 7, '9ef954e04b7d33658193d376b13f496b1c539afe2588d66949f805d837cd84ed'],
        ['x'.repeat(200), 0, '8d3d66f6b58535e7b7dd4dac8174c6b130af6d7d209ba7d13a8fdcb5e59551f2']];
    for (const [text, mask, hash] of vectors) {
        const flat = qrMatrix(text, { mask }).map(row => row.map(d => d ? '1' : '0').join('')).join('/');
        assert.equal(createHash('sha256').update(flat).digest('hex'), hash, text.slice(0, 20));
    }
    assert.throws(() => qrMatrix('x'.repeat(300)), RangeError);
});
test('TOTP matches the RFC 6238 SHA-1 test vectors', async () => {
    const bytes = fromBase32(base32(new TextEncoder().encode('12345678901234567890')));
    for (const [time, code] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [20000000000, '65353130']])
        assert.equal(await totpAt(bytes, Math.floor(time / 30), 8), code);
});
async function mfaWorld(t, policy = {}) {
    const w = await world(t, 'open');
    const set = { mfa: 'required', mfa_trusted_device_days: 0, ...policy };
    w.env.DB.db.prepare('UPDATE clients SET mfa=?, mfa_trusted_device_days=? WHERE id=?').run(set.mfa, set.mfa_trusted_device_days, 'app');
    return w;
}
const form = (w, path, body, cookie) => w.call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie }, body: new URLSearchParams(body) });
const jarOf = (...parts) => parts.filter(Boolean).join('; ');
const csrfOf = jar => jar.match(/__Host-vi_csrf=([^;]+)/)[1];
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
// First sign-in to an MFA-required app: enrol, see recovery codes, continue to the app.
async function enrolThroughApp(w, t) {
    const first = await login(w, t);
    const location = first.response.headers.get('location');
    assert.match(location, /\/account\/mfa\?request_id=/);
    const jar = jarOf(first.flow.cookie, first.cookie), requestId = new URL(location).searchParams.get('request_id');
    const mfa = await enrolMfa(w, jar, csrfOf(jar));
    assert.equal(mfa.recovery.length, 10);
    const done = await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'continue', request_id: requestId }, jar);
    return { jar, mfa, done };
}
test('an MFA-required app makes a first-time person enrol, then issues a code with otp+mfa and the MFA acr', async t => {
    const w = await mfaWorld(t);
    const { done } = await enrolThroughApp(w, t);
    assert.equal(done.status, 303);
    const code = new URL(done.headers.get('location')).searchParams.get('code');
    const claims = claimsOf((await (await w.exchange(code)).json()).id_token);
    assert.deepEqual(claims.amr.sort(), ['email', 'mfa', 'otp']);
    assert.equal(claims.acr, 'urn:imprim:acr:mfa');
    const discovery = await (await w.call('/.well-known/openid-configuration')).json();
    assert.ok(discovery.acr_values_supported.includes('urn:imprim:acr:mfa'));
});
test('a person with a factor is challenged; a wrong code fails; a code is accepted once', async t => {
    const w = await mfaWorld(t);
    const { mfa } = await enrolThroughApp(w, t);
    w.env.DB.db.exec('DELETE FROM sessions');
    const again = await login(w, t);
    assert.match(again.response.headers.get('location'), /\/mfa\?request_id=/);
    const jar = jarOf(again.flow.cookie, again.cookie), request_id = new URL(again.response.headers.get('location'), w.env.ISSUER).searchParams.get('request_id');
    assert.equal((await form(w, '/mfa', { csrf: csrfOf(jar), request_id, code: '000000' }, jar)).status, 401);
    // The step used at enrolment cannot be replayed; the next step can.
    const used = await form(w, '/mfa', { csrf: csrfOf(jar), request_id, code: await mfa.code() }, jar);
    const next = used.status === 303 ? used : await form(w, '/mfa', { csrf: csrfOf(jar), request_id, code: await mfa.code(1) }, jar);
    assert.equal(next.status, 303);
    assert.ok(new URL(next.headers.get('location')).searchParams.get('code'));
    const step = w.env.DB.db.prepare('SELECT last_step FROM mfa_factors').get().last_step;
    assert.ok(step >= currentStep());
});
test('a recovery code works once, is audited and triggers a notice', async t => {
    const w = await mfaWorld(t);
    const { mfa } = await enrolThroughApp(w, t);
    w.env.DB.db.exec('DELETE FROM sessions');
    const run = async code => {
        const again = await login(w, t);
        const jar = jarOf(again.flow.cookie, again.cookie), request_id = new URL(again.response.headers.get('location'), w.env.ISSUER).searchParams.get('request_id');
        return form(w, '/mfa', { csrf: csrfOf(jar), request_id, code }, jar);
    };
    assert.equal((await run(mfa.recovery[0])).status, 303);
    await w.drain();
    assert.ok(w.mails.some(mail => /recovery code was used/.test(mail.subject)));
    w.env.DB.db.exec('DELETE FROM sessions');
    assert.equal((await run(mfa.recovery[0])).status, 401);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='recovery_code_used'").get().n, 1);
});
test('ten wrong codes lock the second factor, even when sent in parallel', async t => {
    const w = await mfaWorld(t);
    const { mfa } = await enrolThroughApp(w, t);
    w.env.DB.db.exec('DELETE FROM sessions');
    const again = await login(w, t);
    const jar = jarOf(again.flow.cookie, again.cookie), request_id = new URL(again.response.headers.get('location'), w.env.ISSUER).searchParams.get('request_id');
    const statuses = await Promise.all(Array.from({ length: 15 }, () => form(w, '/mfa', { csrf: csrfOf(jar), request_id, code: '000000' }, jar).then(r => r.status)));
    assert.equal(statuses.filter(s => s === 401).length, 10);
    assert.equal(statuses.filter(s => s === 429).length, 5);
    assert.equal((await form(w, '/mfa', { csrf: csrfOf(jar), request_id, code: await mfa.code(1) }, jar)).status, 429);
});
test('a trusted browser skips the second factor where the app allows it, never when the app demands MFA', async t => {
    const w = await mfaWorld(t, { mfa_trusted_device_days: 30 });
    const { mfa } = await enrolThroughApp(w, t);
    w.env.DB.db.exec('DELETE FROM sessions');
    const again = await login(w, t);
    const jar = jarOf(again.flow.cookie, again.cookie), request_id = new URL(again.response.headers.get('location'), w.env.ISSUER).searchParams.get('request_id');
    const trusted = await form(w, '/mfa', { csrf: csrfOf(jar), request_id, code: await mfa.code(1), trust: '1' }, jar);
    assert.equal(trusted.status, 303);
    const device = cookieJar(trusted);
    assert.match(device, /__Host-vi_device=/);
    w.env.DB.db.exec('DELETE FROM sessions');
    turnstile(t);
    const flow = await begin(w, device);
    await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, jarOf(flow.cookie, device));
    await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const skipped = await w.post('/v1/auth/magic/verify', { token }, jarOf(flow.cookie, device));
    assert.ok(new URL(skipped.headers.get('location')).searchParams.get('code'), 'device skipped the second factor');
    // acr_values demanding MFA ignores the trusted browser.
    const demand = await w.authorize({ acr_values: 'urn:imprim:acr:mfa' }, jarOf(flow.cookie, device, cookieJar(skipped)));
    assert.match(demand.headers.get('location'), /\/mfa\?request_id=/);
});
test('optional MFA challenges only people who added a factor; prompt=none gets interaction_required', async t => {
    const w = await mfaWorld(t, { mfa: 'optional' });
    const plain = await login(w, t);
    assert.ok(new URL(plain.response.headers.get('location')).searchParams.get('code'), 'no factor: no challenge');
    const jar = jarOf(plain.flow.cookie, plain.cookie);
    await enrolMfa(w, jar, csrfOf(jar));
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    const silent = await w.authorize({ prompt: 'none' }, jar);
    assert.equal(new URL(silent.headers.get('location')).searchParams.get('error'), 'interaction_required');
    assert.match((await w.authorize({}, jar)).headers.get('location'), /\/mfa\?request_id=/);
});
test('max_age forces a fresh primary sign-in', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie);
    w.env.DB.db.prepare('UPDATE sessions SET auth_time=?').run(Math.floor(Date.now() / 1000) - 600);
    const recent = await w.authorize({ max_age: '3600' }, jar);
    assert.equal(recent.status, 303);
    const stale = await w.authorize({ max_age: '60' }, jar);
    assert.equal(stale.status, 200, 'sign-in page, not a code');
    assert.equal((await w.authorize({ max_age: 'soon' }, jar)).status, 303);
    assert.equal(new URL((await w.authorize({ max_age: 'soon' }, jar)).headers.get('location')).searchParams.get('error'), 'invalid_request');
});
test('enrolment needs a fresh sign-in; removing a factor needs a fresh second factor', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie);
    w.env.DB.db.prepare('UPDATE sessions SET auth_time=?').run(Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'start' }, jar)).status, 403);
    w.env.DB.db.prepare('UPDATE sessions SET auth_time=?').run(Math.floor(Date.now() / 1000));
    await enrolMfa(w, jar, csrfOf(jar));
    const id = w.env.DB.db.prepare('SELECT id FROM mfa_factors').get().id;
    w.env.DB.db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now() - 3600000);
    assert.equal((await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'remove', factor_id: id }, jar)).status, 403);
    w.env.DB.db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now());
    assert.equal((await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'remove', factor_id: id }, jar)).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM recovery_codes').get().n, 0, 'last factor gone: recovery codes gone');
    assert.equal((await form(w, '/account/mfa', { action: 'start' }, jar)).status, 403, 'CSRF required');
});
test('administrators must enrol and verify a second factor before the console opens', async t => {
    const w = await world(t); turnstile(t);
    const page = await w.call('/login'), browser = cookieJar(page);
    await w.post('/v1/auth/magic/request', { email: 'admin@example.com', turnstile: crypto.randomUUID() }, browser);
    await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const jar = jarOf(browser, cookieJar(await w.post('/v1/auth/magic/verify', { token }, browser)));
    const html = await w.call('/admin/clients', { headers: { cookie: jar } });
    assert.equal(html.status, 303);
    assert.equal(html.headers.get('location'), 'https://id.example.com/account/mfa?next=%2Fadmin%2Fclients');
    const api = await w.call('/admin/api/clients', { headers: { cookie: jar } });
    assert.equal((await api.json()).error, 'mfa_required');
    await enrolMfa(w, jar, csrfOf(jar));
    assert.equal((await w.call('/admin/api/clients', { headers: { cookie: jar } })).status, 200);
    w.env.DB.db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now() - 2 * 3600000);
    assert.equal((await (await w.call('/admin/api/clients', { headers: { cookie: jar } })).json()).error, 'mfa_required');
});
test('an app can require a recent second factor before a person approves an agent', async t => {
    const w = await agentWorld(t);
    w.env.DB.db.exec("UPDATE clients SET agent_consent_mfa='required' WHERE id='app'");
    const flow = await w.start();
    const consent = await w.call(`/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie } });
    assert.equal(consent.status, 303);
    assert.match(consent.headers.get('location'), /\/account\/mfa\?request_id=/);
    assert.equal((await w.approve(flow)).status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 0, 'no grant without the second factor');
});
test('imprim-client passes acr_values and max_age for step-up', async () => {
    const { createClient } = await import('../packages/imprim-client/index.mjs');
    const client = createClient({ issuer: 'https://id.example.com', clientId: 'app', redirectUri: 'https://app.example/callback', fetch: async () => Response.json({ issuer: 'https://id.example.com', id_token_signing_alg_values_supported: ['ES256'], code_challenge_methods_supported: ['S256'],
        authorization_endpoint: 'https://id.example.com/authorize', token_endpoint: 'https://id.example.com/token', jwks_uri: 'https://id.example.com/.well-known/jwks.json', end_session_endpoint: 'https://id.example.com/logout' }) });
    const url = new URL((await client.startLogin({ acrValues: 'urn:imprim:acr:mfa', maxAge: 300 })).url);
    assert.equal(url.searchParams.get('acr_values'), 'urn:imprim:acr:mfa');
    assert.equal(url.searchParams.get('max_age'), '300');
    await assert.rejects(client.startLogin({ maxAge: -1 }));
});

// Review findings: two-factor.
test('review 1: a sign-in without the second factor cannot enrol another authenticator', async t => {
    const w = await mfaWorld(t);
    const { mfa } = await enrolThroughApp(w, t);
    w.env.DB.db.exec('DELETE FROM sessions');
    const again = await login(w, t);
    const jar = jarOf(again.flow.cookie, again.cookie);
    const start = await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'start' }, jar);
    assert.equal(start.status, 403);
    assert.equal((await start.json()).error, 'mfa_required');
    const factor = w.env.DB.db.prepare('SELECT id FROM mfa_factors').get().id;
    assert.equal((await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'confirm', factor_id: factor, code: await mfa.code(1) }, jar)).status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM mfa_factors').get().n, 1);
    assert.equal(w.env.DB.db.prepare('SELECT mfa_at FROM sessions').get().mfa_at, null);
});
test('review 1: an admin mailbox alone does not open the console when the admin has a factor', async t => {
    const w = await world(t); turnstile(t);
    const { adminLogin } = await import('./support/admin.mjs');
    await adminLogin(w);
    w.env.DB.db.exec('DELETE FROM sessions');
    const page = await w.call('/login'), browser = cookieJar(page);
    await w.post('/v1/auth/magic/request', { email: 'admin@example.com', turnstile: crypto.randomUUID() }, browser);
    await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const jar = jarOf(browser, cookieJar(await w.post('/v1/auth/magic/verify', { token }, browser)));
    assert.equal((await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'start' }, jar)).status, 403);
    assert.equal((await (await w.call('/admin/api/clients', { headers: { cookie: jar } })).json()).error, 'mfa_required');
});
test('review 2: prompt=login and max_age hold through the second-factor continuation', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie);
    w.env.DB.db.prepare('UPDATE sessions SET auth_time=?').run(Math.floor(Date.now() / 1000) - 7200);
    for (const changes of [{ max_age: '60' }, { prompt: 'login' }]) {
        const page = await w.authorize(changes, jar);
        assert.equal(page.status, 200);
        const request_id = (await page.text()).match(/data-request-id="([^"]+)"/)[1];
        const cont = await form(w, '/account/mfa', { csrf: csrfOf(jar), action: 'continue', request_id }, jar);
        assert.equal(cont.status, 401, JSON.stringify(changes));
        assert.equal((await cont.json()).error, 'login_required');
    }
});
test('review 3: refused attempts do not extend the lock', async t => {
    const w = await world(t);
    const { attempt, PASSWORD_FAILURE_LIMIT } = await import('../apps/server/src/auth/rate-limit.mjs');
    for (let i = 0; i < PASSWORD_FAILURE_LIMIT; i++) await attempt(w.env, 'probe');
    const locked = w.env.DB.db.prepare("SELECT expires_at FROM rate_limits WHERE key='probe'").get().expires_at;
    assert.equal(await attempt(w.env, 'probe'), false);
    assert.equal(w.env.DB.db.prepare("SELECT expires_at FROM rate_limits WHERE key='probe'").get().expires_at, locked);
});
test('review 4: a browser trusted by one app does not skip another app\'s second factor', async t => {
    const w = await mfaWorld(t, { mfa_trusted_device_days: 30 });
    w.env.DB.db.exec("UPDATE clients SET mfa='required', mfa_trusted_device_days=30 WHERE id='other'");
    const { mfa } = await enrolThroughApp(w, t);
    w.env.DB.db.exec('DELETE FROM sessions');
    const again = await login(w, t);
    const jar = jarOf(again.flow.cookie, again.cookie), request_id = new URL(again.response.headers.get('location'), w.env.ISSUER).searchParams.get('request_id');
    const trusted = await form(w, '/mfa', { csrf: csrfOf(jar), request_id, code: await mfa.code(1), trust: '1' }, jar);
    const device = cookieJar(trusted);
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=NULL');
    const other = await w.authorize({ client_id: 'other' }, jarOf(jar, device));
    assert.match(other.headers.get('location'), /\/mfa\?request_id=/);
});

test('the two-factor pages are Fire markup and escape factor names and carried values', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = jarOf(flow.cookie, cookie), csrf = csrfOf(jar);
    const start = await form(w, '/account/mfa', { csrf, action: 'start', next: '/account"><b>x' }, jar);
    const setup = await start.text();
    assertFireMarkup(setup);
    assert.match(setup, /<figure class="fd-qr"><svg/);
    assert.match(setup, /<form class="fd-form" method="post" action="\/account\/mfa"><input type="hidden" name="csrf" value="[^"]+">/);
    assert.ok(setup.includes('<input type="hidden" name="next" value="/account&quot;&gt;&lt;b&gt;x">') && !setup.includes('"><b>x'), 'next is escaped');
    // The 6-digit code is Fire's one-time-code field: one ordinary input (it works without script) that /imprim/forms.js
    // turns into six boxes.
    assert.ok(setup.includes('<div class="fd-otp" data-fd-otp data-length="6" role="group" aria-label="Code"><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div>'));
    assert.ok(setup.includes('<script type="module" src="/imprim/forms.js"></script>'));
    assert.match(setup, /<input class="fd-input" id="name" aria-describedby="name-hint" name="name" value="Authenticator app" maxlength="60" required>/);
    await enrolMfa(w, jar, csrf);
    w.env.DB.db.prepare('UPDATE mfa_factors SET name=?').run('<img src=x onerror=alert(1)>');
    const overview = await (await w.call('/account/mfa', { headers: { cookie: jar } })).text();
    assertFireMarkup(overview);
    assert.ok(!overview.includes('<img src=x') && overview.includes('&lt;img src=x onerror=alert(1)&gt;'), 'factor name is escaped');
    assert.match(overview, /aria-label="Remove &lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.match(overview, /<input type="hidden" name="action" value="remove"><input type="hidden" name="factor_id" value="[^"]+">/);
    assert.match(overview, /<h3 class="fd-setting-title">10 unused codes<\/h3>/);
    assert.match(overview, /<form[^>]+id="passkey-rename" hidden>/);
    assert.match(overview, /id="passkey-name" name="name" maxlength="60" required/);
    assert.doesNotMatch(overview, /class="fd-empty"/);
    assert.match(overview, /<button class="fd-btn" type="button" data-variant="outline" data-size="lg" id="passkey-add">/);
    // Script failures appear in a danger notice that stays hidden until there is one.
    assert.match(overview, /<div class="fd-callout" id="message-box" hidden data-tone="danger" role="alert">.*?<p class="fd-callout-body" id="message"><\/p><\/div><\/div>/);
    assert.ok(overview.includes('<script src="/assets/passkey.js" defer></script>'));
    assert.ok(!overview.includes('data-variant="primary"'), 'with a factor, adding another is not the primary action');
    const codes = await (await form(w, '/account/mfa', { csrf, action: 'recovery' }, jar)).text();
    assertFireMarkup(codes);
    assert.equal([...codes.matchAll(/<li><code class="fd-code">[A-Z2-7-]+<\/code><\/li>/g)].length, 10);
    assert.match(codes, /<ul class="fd-grid"[^>]*id="recovery-codes"/);
    const challenge = await w.call('/mfa?next=%2Faccount%22%3E%3Cb%3Ex', { headers: { cookie: jar } });
    assert.equal(challenge.status, 200);
    const html = await challenge.text();
    assertFireMarkup(html);
    assert.ok(html.includes('<input type="hidden" name="next" value="/account&quot;&gt;&lt;b&gt;x">') && !html.includes('"><b>x'));
    assert.ok(!html.includes('id="passkey-mfa"') && !html.includes('/assets/passkey.js'), 'no passkey, no passkey button');
    assert.ok(!html.includes('name="trust"'), 'no app, no trusted browser');
    const wrong = await form(w, '/mfa', { csrf, code: '000000' }, jar);
    assert.equal(wrong.status, 401);
    const refused = await wrong.text();
    assert.ok(refused.includes('<div class="fd-otp" data-fd-otp data-length="6" role="group" aria-label="Code"><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus aria-invalid="true" aria-describedby="code-error"></div>'));
    assert.match(refused, /<p class="fd-field-error" id="code-error">.*<span>That code didn’t work\. Enter the newest code from your app\.<\/span><\/p>/);
    assert.ok(refused.includes('<script type="module" src="/imprim/forms.js"></script>'));
    // A recovery code has its own field, reached by a link that keeps where the person was going.
    assert.match(refused, /<a class="fd-link" href="\/mfa\?recovery=1">Use a recovery code<\/a>/);
    const recovery = await (await w.call('/mfa?recovery=1&next=/account/mfa', { headers: { cookie: jar } })).text();
    assertFireMarkup(recovery);
    assert.match(recovery, /<h1 class="fd-h1">Enter a recovery code<\/h1>/);
    assert.match(recovery, /<input type="hidden" name="recovery" value="1">/);
    assert.match(recovery, /<input class="fd-input" id="code" data-size="lg" aria-describedby="code-hint" name="code" autocomplete="off" autocapitalize="characters" inputmode="text" maxlength="11" required autofocus spellcheck="false">/);
    assert.ok(!recovery.includes('fd-otp') && !recovery.includes('/imprim/forms.js'), 'a recovery code is not six digits: a plain field, no boxes');
    assert.match(recovery, /<a class="fd-link" href="\/mfa\?next=%2Faccount%2Fmfa">Enter a code from your app<\/a>/);
    const wrongRecovery = await form(w, '/mfa', { csrf, code: 'AAAAA-BBBBB', recovery: '1' }, jar);
    assert.equal(wrongRecovery.status, 401);
    assert.match(await wrongRecovery.text(), /<input type="hidden" name="recovery" value="1">[\s\S]*That code didn’t work\. Check it, or use another recovery code\./);
});
test('the second-factor step offers the trusted browser only where the app allows it, in the app\'s brand', async t => {
    const w = await mfaWorld(t, { mfa_trusted_device_days: 30 });
    await enrolThroughApp(w, t);
    w.env.DB.db.exec('DELETE FROM sessions');
    const again = await login(w, t);
    const jar = jarOf(again.flow.cookie, again.cookie), location = again.response.headers.get('location');
    const html = await (await w.call(new URL(location, w.env.ISSUER).pathname + new URL(location, w.env.ISSUER).search, { headers: { cookie: jar } })).text();
    assertFireMarkup(html);
    assert.match(html, /<label class="fd-checkbox"><input type="checkbox" name="trust" value="1">.*Trust this browser for 30 days/);
    assert.ok(html.includes('/assets/theme.css?client=app'), 'wears the app\'s brand');
});
test('an administrator sent from the console to add a second factor is told why', async t => {
    const w = await world(t); turnstile(t);
    const page = await w.call('/login'), browser = cookieJar(page);
    await w.post('/v1/auth/magic/request', { email: 'admin@example.com', turnstile: crypto.randomUUID() }, browser); await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const cookie = cookieJar(await w.post('/v1/auth/magic/verify', { token }, browser));
    const console = await w.call('/admin', { headers: { cookie } });
    assert.equal(console.status, 303); assert.match(console.headers.get('location'), /\/account\/mfa\?next=%2Fadmin$/);
    const html = await (await w.call('/account/mfa?next=%2Fadmin', { headers: { cookie } })).text();
    assert.match(html, /Add a second factor to open the admin console/);
    assert.doesNotMatch(await (await w.call('/account/mfa', { headers: { cookie } })).text(), /open the admin console/);
});
