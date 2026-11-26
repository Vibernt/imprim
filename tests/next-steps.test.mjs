// A page that says "sign in" or "start again" links to it (apps/server/src/pages/next-steps.mjs): the sign-in still
// open in this browser, the app's own sign-in page (initiate_login_uri), or the realm's apps. Never another browser's
// sign-in, and never a guessed address.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, begin, cookieJar, turnstile } from './support/world.mjs';
import { agentWorld } from './support/agents.mjs';
import { MAX_LISTED_APPS } from '../apps/server/src/pages/next-steps.mjs';

const html = { accept: 'text/html' };
const page = async (w, path, cookie = '') => {
    const response = await w.call(path, { headers: { ...html, cookie } });
    return { response, text: await response.text() };
};
const signInAgain = id => `href="/login?request_id=${id}"`;
const setLoginUri = (w, id, uri, name) => w.env.DB.db.prepare('UPDATE clients SET initiate_login_uri=?, branding=? WHERE id=?')
    .run(uri, JSON.stringify(name ? { name } : {}), id);

test('/login with a live request of this browser is that app’s sign-in page again; any other request_id is ignored', async t => {
    const w = await world(t), flow = await begin(w), other = await begin(w);
    const again = await page(w, `/login?request_id=${flow.request_id}`, flow.cookie);
    assert.equal(again.response.status, 200);
    assert.match(again.text, new RegExp(`data-request-id="${flow.request_id}"`));
    assert.doesNotMatch(again.text, /Administrators sign in by email/);
    // Negative: another browser's request, an unknown id, an expired request and no browser cookie all give the
    // administrators' page, with no request in it.
    for (const [id, cookie] of [[flow.request_id, other.cookie], ['nope', flow.cookie], [flow.request_id, '']]) {
        const plain = await page(w, `/login?request_id=${id}`, cookie);
        assert.equal(plain.response.status, 200);
        assert.match(plain.text, /data-request-id=""/);
        assert.match(plain.text, /Administrators sign in by email/);
    }
    w.env.DB.db.prepare('UPDATE auth_requests SET expires_at=0 WHERE id=?').run(flow.request_id);
    assert.match((await page(w, `/login?request_id=${flow.request_id}`, flow.cookie)).text, /data-request-id=""/);
});

test('an app’s email link carries its request, so an expired link sits on the app’s sign-in page; an administrator’s does not', async t => {
    const w = await world(t); turnstile(t);
    const flow = await begin(w);
    await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, flow.cookie);
    await w.drain();
    const link = w.mails.at(-1).text.match(/https:\/\/\S+#token=\S+/)[0];
    assert.equal(new URL(link).pathname + new URL(link).search, `/login?request_id=${flow.request_id}`);
    // The link page is the app's sign-in page, and its script shows the form again when the link fails.
    const opened = await page(w, new URL(link).pathname + new URL(link).search, flow.cookie);
    assert.match(opened.text, new RegExp(`data-request-id="${flow.request_id}"`));
    const script = await (await w.call('/assets/sign-in.js')).text();
    assert.match(script, /document\.getElementById\('confirm'\)\.hidden=true;document\.getElementById\('request'\)\.hidden=false;/);
    const admin = await w.call('/login'), jar = cookieJar(admin);
    await w.post('/v1/auth/magic/request', { email: 'admin@example.com', turnstile: crypto.randomUUID() }, jar);
    await w.drain();
    assert.match(w.mails.at(-1).text, /https:\/\/id\.example\.com\/login#token=/);
});

test('a sign-in that stops offers "Sign in again" only to the browser that started it', async t => {
    const w = await world(t), flow = await begin(w), other = await begin(w);
    // Signed out on a step of the request (the hosted join page, the second-factor page).
    const join = await page(w, `/workspace-join?request_id=${flow.request_id}`, flow.cookie);
    assert.equal(join.response.status, 401);
    assert.match(join.text, /Sign-in stopped/);
    assert.ok(join.text.includes(signInAgain(flow.request_id)), 'Sign in again links to this request');
    assert.doesNotMatch(join.text, /Go back to the app and start again/);
    const mfa = await page(w, `/mfa?request_id=${flow.request_id}`, flow.cookie);
    assert.equal(mfa.response.status, 401);
    assert.ok(mfa.text.includes(signInAgain(flow.request_id)), 'Sign in again links to this request');
    // Negative: another browser gets no link into this request: the app's page if it has one, else the plain line.
    const foreign = await page(w, `/workspace-join?request_id=${flow.request_id}`, other.cookie);
    assert.doesNotMatch(foreign.text, /request_id=/);
    assert.match(foreign.text, /Go back to the app and start again/);
    setLoginUri(w, 'app', 'https://app.example/start', 'Example App');
    const withApp = await page(w, `/workspace-join?request_id=${flow.request_id}`, other.cookie);
    assert.doesNotMatch(withApp.text, /request_id=/);
    assert.match(withApp.text, /href="https:\/\/app\.example\/start"/);
    assert.match(withApp.text, /Sign in to Example App/);
    // Only that app: another app with a sign-in page is not offered for this request.
    setLoginUri(w, 'other', 'https://other.example/start', 'Other');
    assert.doesNotMatch((await page(w, `/workspace-join?request_id=${flow.request_id}`, other.cookie)).text, /other\.example/);
});

test('with no app in view, the pages that say "sign in" list the realm’s apps that have a sign-in page', async t => {
    const w = await world(t);
    // None configured: the pages keep their words and invent no address.
    const none = await page(w, '/error');
    assert.match(none.text, /Go back to the app and start again/);
    assert.doesNotMatch((await page(w, '/account')).text, /app\.example\/start/);
    setLoginUri(w, 'app', 'https://app.example/start', 'Example App');
    const error = await page(w, '/error');
    assert.match(error.text, /href="https:\/\/app\.example\/start"/);
    assert.match(error.text, /Sign in to Example App/);
    const account = await page(w, '/account');
    assert.equal(account.response.status, 401);
    assert.match(account.text, /Sign in to see your account/);
    assert.match(account.text, /href="https:\/\/app\.example\/start"/);
    assert.match((await page(w, '/signed-out')).text, /href="https:\/\/app\.example\/start"/);
    const login = await page(w, '/login');
    assert.match(login.text, /Signing in to an app\? Start from the app:/);
    assert.match(login.text, /<a class="fd-link" href="https:\/\/app\.example\/start">Example App<\/a>/);
    // An app without a name is listed by its id; a branding name with markup is escaped.
    setLoginUri(w, 'other', 'https://other.example/start', '<b>Other</b>');
    const two = (await page(w, '/signed-out')).text;
    assert.match(two, /Sign in to &lt;b&gt;Other&lt;\/b&gt;/);
    assert.doesNotMatch(two, /<b>Other<\/b>/);
    // More apps than a short choice: none are listed.
    for (let i = 0; i < MAX_LISTED_APPS; i += 1) w.env.DB.db.prepare(`INSERT INTO clients(id,redirect_uris,initiate_login_uri) VALUES(?,?,?)`)
        .run(`extra-${i}`, JSON.stringify(['https://app.example/callback']), `https://extra-${i}.example/start`);
    assert.doesNotMatch((await page(w, '/signed-out')).text, /\.example\/start/);
    assert.match((await page(w, '/error')).text, /Go back to the app and start again/);
});

test('a failed lookup of the apps leaves the signed-out and error pages as they were', async t => {
    const w = await world(t);
    setLoginUri(w, 'app', 'https://app.example/start', 'Example App');
    const prepare = w.env.DB.prepare.bind(w.env.DB);
    w.env.DB.prepare = sql => { if (/initiate_login_uri IS NOT NULL/.test(sql)) throw new Error('database unavailable'); return prepare(sql); };
    t.after(() => { w.env.DB.prepare = prepare; });
    const out = await page(w, '/signed-out');
    assert.equal(out.response.status, 200);
    assert.match(out.text, /You’re signed out/);
    assert.doesNotMatch(out.text, /app\.example/);
    const error = await page(w, '/error');
    assert.equal(error.response.status, 400);
    assert.match(error.text, /Go back to the app and start again/);
});

test('another realm’s apps are never offered', async t => {
    const w = await world(t);
    w.env.DB.db.prepare("INSERT INTO realms(id,issuer,display_name,created) VALUES('acme','https://id.acme.test','Acme',0)").run();
    w.env.DB.db.prepare("INSERT INTO clients(id,redirect_uris,initiate_login_uri,realm_id) VALUES('acme-app',?,?,'acme')")
        .run(JSON.stringify(['https://acme.example/callback']), 'https://acme.example/start');
    assert.doesNotMatch((await page(w, '/signed-out')).text, /acme\.example/);
});

test('a wrong device code leads back to the code form', async t => {
    const w = await world(t);
    const wrong = await page(w, '/device?user_code=BCDF-GHJK');
    assert.equal(wrong.response.status, 400);
    assert.match(wrong.text, /href="\/device"/);
    assert.match(wrong.text, /Enter the code again/);
});

test('a refused consent form answers a page, not JSON, to a browser; scripts still get JSON', async t => {
    const w = await agentWorld(t), flow = await w.start();
    const refused = await w.form('/agent/consent', { request_id: flow.id, csrf: 'wrong', decision: 'approve' }, flow.cookie, html);
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get('content-type'), /^text\/html/);
    const text = await refused.text();
    assert.match(text, /Sign-in stopped/);
    assert.ok(text.includes(signInAgain(flow.id)), 'Sign in again links to this request');
    const script = await w.form('/agent/consent', { request_id: flow.id, csrf: 'wrong', decision: 'approve' }, flow.cookie);
    assert.match(script.headers.get('content-type'), /^application\/json/);
});
