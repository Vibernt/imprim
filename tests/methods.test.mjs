import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { world, begin, turnstile, login, cookieJar } from './support/world.mjs';
import { fakeGoogle, googleCallback } from './support/google.mjs';
const setMethods = (w, methods) => w.env.DB.db.prepare('UPDATE clients SET sign_in_methods=? WHERE id=?').run(JSON.stringify(methods), 'app');
for (const methods of [['google'], ['github'], ['email'], ['google','email','github'], ['github','google','email'], ['email','github']])
    test(`page shows exactly ${methods.join(', ')} in order and its script runs without missing-form errors`, async t => {
        const w = await world(t); setMethods(w, methods);
        const html = await (await w.authorize()).text(), controls = html.match(/<section id="request"[^>]*>([\s\S]*?)<\/section>/)[1];
        const markers = { email: 'id="email-form"', github: 'Sign in with GitHub', google: 'Sign in with Google' };
        for (const [method, marker] of Object.entries(markers)) assert.equal(controls.includes(marker), methods.includes(method));
        const positions = methods.map(method => controls.indexOf(markers[method]));
        assert.deepEqual(positions, [...positions].sort((a,b) => a-b));
        // Each provider button carries that provider's mark: Google's file as an image, the others inline.
        assert.equal(controls.includes('<img class="fd-icon" src="/imprim/google-g.svg" alt=""'), methods.includes('google'));
        assert.equal(/<svg class="fd-icon" viewBox="0 0 16 16"[^>]*>.*?<\/svg><span>Sign in with GitHub/.test(controls), methods.includes('github'));
        assert.match(html, /<script src="\/assets\/sign-in.js" defer><\/script>/);
        const script = await (await w.call('/assets/sign-in.js')).text();
        runInNewContext(script, { URLSearchParams, location: { hash: '' }, document: { getElementById(id) {
            if (id === 'email-form' && !methods.includes('email')) return null;
            return { addEventListener() {} };
        } } });
    });
for (const method of ['email','github','google']) test(`${method} start/request is refused when pending client excludes it`, async t => {
    const w = await world(t); setMethods(w, method === 'google' ? ['email','github'] : ['google']);
    const flow = await begin(w);
    const calls = []; t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); throw Error('unexpected provider I/O'); });
    const response = method === 'email'
        ? await w.post('/v1/auth/magic/request', { email: 'person@example.com', request_id: flow.request_id, turnstile: 'unused' }, flow.cookie)
        : await w.call(`/v1/auth/${method}/start?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } });
    assert.equal(response.status, 403); assert.equal((await response.json()).error, 'access_denied');
    await w.drain(); assert.equal(w.mails.length, 0); assert.equal(calls.length, 0);
    for (const table of ['sessions','magic_links','oauth_states']) assert.equal(w.env.DB.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
});
for (const method of ['email','github','google']) test(`${method} verify/callback rechecks current client policy before issuing a session`, async t => {
    const w = await world(t); let callback;
    if (method === 'email') {
        turnstile(t); const flow = await begin(w);
        await w.post('/v1/auth/magic/request', { email: 'person@example.com', request_id: flow.request_id, turnstile: 'token' }, flow.cookie); await w.drain();
        const token = w.mails[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
        callback = () => w.post('/v1/auth/magic/verify', { token }, flow.cookie);
    } else if (method === 'google') {
        const fake = fakeGoogle(t, w), flow = await fake.start(); callback = () => googleCallback(w, flow);
    } else {
        const flow = await begin(w), start = await w.call(`/v1/auth/github/start?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } });
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        callback = () => w.call('/auth/github/callback?' + new URLSearchParams({ state, code: 'github-code' }), { headers: { cookie: flow.cookie + '; ' + cookieJar(start) } });
    }
    setMethods(w, method === 'google' ? ['email','github'] : ['google']);
    const calls = []; t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); throw Error('unexpected network'); });
    const response = await callback(); assert.equal(response.status, 403); assert.equal(calls.length, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM codes').get().n, 0);
});
test('email session cannot silently or interactively bypass a google-only app', async t => {
    const w = await world(t), signed = await login(w, t); setMethods(w, ['google']);
    const response = await w.authorize({ prompt: 'none' }, signed.cookie);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'login_required');
    const html = await (await w.authorize({}, signed.cookie)).text(); assert.match(html, /Sign in with Google/); assert.ok(!html.includes('id="email-form"'));
    assert.equal((await w.exchange(signed.code)).status, 403);
});
test('Google session rechecks hosted domains at SSO and token exchange', async t => {
    const w = await world(t), fake = fakeGoogle(t, w), response = await googleCallback(w, await fake.start());
    assert.equal(response.status, 303);
    w.env.DB.db.exec(`UPDATE clients SET google_hosted_domains='["other.example"]'`);
    const sso = await w.authorize({ prompt: 'none' }, cookieJar(response));
    assert.equal(new URL(sso.headers.get('location')).searchParams.get('error'), 'login_required');
    assert.equal((await w.exchange(new URL(response.headers.get('location')).searchParams.get('code'))).status, 403);
});
test('Google callback refuses client policy changed during the token exchange', async t => {
    const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start(), fetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (...args) => { setMethods(w, ['email']); return fetch(...args); });
    assert.equal((await googleCallback(w, flow)).status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});
test('provider states cannot be spent at the other provider callback', async t => {
    const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start();
    const response = await w.call('/auth/github/callback?' + new URLSearchParams({ state: flow.url.searchParams.get('state'), code: 'code' }), { headers: { cookie: flow.cookie } });
    assert.equal(response.status, 401); assert.equal(fake.calls.length, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM oauth_states').get().n, 1);
    assert.equal((await googleCallback(w, flow)).status, 303);
});
