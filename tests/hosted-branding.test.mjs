import assert from 'node:assert/strict';
import test from 'node:test';
import { signInPage } from '../apps/server/src/pages/sign-in.mjs';
import { assertFireMarkup, enrolMfa } from './support/admin.mjs';
import { agentWorld, metadataId, resource } from './support/agents.mjs';
import { addTeam, joinWorld, jarOf } from './support/workspace-join.mjs';
import { begin, cookieJar, turnstile, world } from './support/world.mjs';

const mark = 'b'.repeat(64);
const branding = JSON.stringify({ name: 'Notes Studio', look: { palette: 'iris' }, mark });
const acceptHtml = { accept: 'text/html' };
const get = (w, path, cookie) => w.call(path, { headers: { cookie, ...acceptHtml } });
function branded(html, client = 'app') {
    assertFireMarkup(html);
    assert.match(html, new RegExp(`/assets/theme\\.css\\?client=${client}`));
    assert.match(html, new RegExp(`/assets/brand/${mark}`));
    assert.match(html, /data-palette="iris"/);
    assert.match(html, /fd-brand-name">Notes Studio/);
}
const account = (html, email) => {
    assert.ok(html.includes(`Signed in as ${email}`));
    assert.match(html, /action="\/switch-account"/);
};

test('email confirmation keeps its brand and its typed address without exposing delivery or putting email in the URL', async t => {
    const w = await world(t, 'invited'); turnstile(t);
    w.env.DB.db.prepare("UPDATE clients SET branding=? WHERE id='app'").run(branding);
    const { request_id: id, cookie } = await begin(w);
    const input = 'NotInvited@Example.com';
    const sent = await w.post('/v1/auth/magic/request', { request_id: id, email: input, browser_page: true, turnstile: 'proof' }, cookie);
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { accepted: true });
    assert.match(sent.headers.get('set-cookie'), /^__Host-vi_check_email=.*Secure.*Max-Age=120.*HttpOnly/);
    await w.drain();
    assert.equal(w.mails.length, 0);
    const fullCookie = jarOf(cookie, cookieJar(sent));
    const visit = await get(w, `/check-email?request_id=${id}`, fullCookie);
    const html = await visit.text();
    branded(html);
    assert.match(html, /If NotInvited@Example\.com can sign in here, a link is on its way\./);
    assert.ok(html.includes(`href="/login?request_id=${id}">Use a different email`));
    const other = await begin(w);
    const foreign = await get(w, `/check-email?request_id=${id}`, jarOf(other.cookie, cookieJar(sent)));
    assert.equal(foreign.status, 403);
    assert.doesNotMatch(await foreign.text(), /NotInvited/);
    assert.doesNotMatch(await (await get(w, `/check-email?request_id=${other.request_id}`, jarOf(other.cookie, cookieJar(sent)))).text(), /NotInvited/);
    branded(await (await get(w, `/signup-pending?request_id=${id}`, cookie)).text());
});

test('MFA setup, TOTP challenge, recovery, password setup and a request error retain the app brand', async t => {
    const w = await joinWorld(t), person = await w.person();
    w.db.prepare("UPDATE clients SET branding=?,mfa='required',sign_in_methods='[\"email\",\"password\"]' WHERE id='app'").run(branding);
    const flow = await begin(w);
    const cookie = jarOf(person.cookie, flow.cookie), id = flow.request_id;
    const setup = await (await get(w, `/account/mfa?request_id=${id}`, cookie)).text();
    branded(setup);
    account(setup, person.user.email);
    assert.match(setup, /data-tone="info".*Notes Studio asks for a second step/s);
    const start = await w.form('/account/mfa', { action: 'start', request_id: id, csrf: person.csrf }, cookie);
    assert.equal(start.status, 200);
    const qr = await start.text();
    branded(qr);
    account(qr, person.user.email);
    assert.doesNotMatch(qr, /<article class="fd-card".*<div class="fd-card"/s);
    await enrolMfa(w, cookie, person.csrf);
    for (const mode of ['', '&recovery=1']) {
        const challenge = await (await get(w, `/mfa?request_id=${id}${mode}`, cookie)).text();
        branded(challenge);
        account(challenge, person.user.email);
        assert.match(challenge, mode ? /Have your authenticator app\?.*two-step sign-in|two-step sign-in.*Have your authenticator app\?/s : /enter the six-digit code/);
    }
    const setupPassword = await (await get(w, `/account/password?request_id=${id}`, cookie)).text();
    branded(setupPassword);
    assert.match(setupPassword, /class="fd-callout" data-tone="info".*Saving signs out your other sessions/s);
    const accountPassword = await (await get(w, '/account/password', cookie)).text();
    assert.match(accountPassword, /class="fd-body"><a class="fd-link" href="\/account\/security">Security/);
    const logout = await (await get(w, '/logout', cookie)).text();
    assert.match(logout, /Sign out of Vibernt\?.*Signed in as owner@example\.com/s);
    assert.doesNotMatch(logout, /switch-account/);
    const error = await (await get(w, `/error?request_id=${id}`, cookie)).text();
    branded(error);
    assert.match(error, /data-variant="primary"[^>]*>.*Sign in again/s);
    w.db.prepare('UPDATE auth_requests SET expires_at=0 WHERE id=?').run(id);
    const expired = await (await get(w, `/error?request_id=${id}`, cookie)).text();
    branded(expired);
    assert.match(expired, /This sign-in has expired.*Go back to the app and start again/s);
});

test('workspace join shows an account line, a plain row and a translated product name', async t => {
    const w = await joinWorld(t), owner = await w.person();
    w.db.prepare("UPDATE clients SET branding=? WHERE id='other'").run(branding);
    w.db.exec(`UPDATE clients SET branding='{"name":"Notes"}' WHERE id='app'`);
    addTeam(w.db, 'team', owner.user.id, { name: 'Editorial', product: 'notes' });
    const flow = await w.offer(owner);
    const html = await (await get(w, flow.path, flow.cookie)).text();
    branded(html, 'other');
    account(html, owner.user.email);
    assert.match(html, /type="hidden" name="workspace_id" value="team"/);
    assert.doesNotMatch(html, /type="radio"|>notes</);
    assert.match(html, /Used by Notes/);
    assert.match(html, /<p class="fd-body">Its members will be able to sign in to Notes Studio\./);
    assert.match(html, /Connect Editorial/);
});

test('device review, agent consent and both device results keep app branding', async t => {
    const w = await agentWorld(t);
    w.env.DB.db.prepare("UPDATE clients SET branding=? WHERE id='app'").run(branding);
    for (const decision of ['approve', 'deny']) {
        const device = await (await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' })).json();
        assert.ok(device.user_code, JSON.stringify(device));
        const entered = await get(w, `/device?user_code=${device.user_code}`, w.cookie);
        const review = new URL(entered.headers.get('location'));
        const id = review.searchParams.get('request_id'), cookie = jarOf(w.cookie, cookieJar(entered));
        const reviewHtml = await (await get(w, review.pathname + review.search, cookie)).text();
        branded(reviewHtml);
        account(reviewHtml, w.user.email);
        const consent = await (await get(w, `/agent/consent?request_id=${id}`, cookie)).text();
        branded(consent);
        account(consent, w.user.email);
        assert.doesNotMatch(consent, /<script[^>]*src="\/fire\//);
        const result = await w.approve({ id, cookie, scopes: ['read'] }, decision);
        assert.equal(result.status, 200);
        const html = await result.text();
        branded(html);
        assert.match(html, /You can close this tab\./);
    }
});

test('configured providers render their marks while a generic OIDC provider has none', async t => {
    const w = await world(t);
    const client = { id: 'app', branding, sign_in_methods: '["github","google","work","apple","custom"]', google_hosted_domains: '[]' };
    const env = { ...w.env, PROVIDERS: { work: { type: 'microsoft', name: 'Microsoft' }, apple: { type: 'apple', name: 'Apple' }, custom: { type: 'oidc', name: 'Custom' } } };
    const html = await signInPage(env, 'request', [], client).text();
    assertFireMarkup(html);
    for (const provider of ['GitHub', 'Microsoft', 'Apple']) assert.match(html, new RegExp(`<svg class="fd-icon"[^>]*>[^\\n]*</svg><span>Sign in with ${provider}</span>`));
    assert.match(html, /start\?request_id=request"><span>Sign in with Custom/);
    assert.doesNotMatch(html, /<script[^>]*src="\/fire\//);
});
