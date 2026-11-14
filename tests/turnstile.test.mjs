// Adapted from Assay tests/turnstile.test.mjs, excluding its explicitly unsupported degraded mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, begin, turnstile } from './support/world.mjs';
async function attempt(w, flow, token = 'challenge') {
    const response = await w.post('/v1/auth/magic/request', { email: 'person@example.com', request_id: flow.request_id, turnstile: token }, flow.cookie);
    await w.drain(); return response;
}
for (const [name, value] of Object.entries({ invalid: { success: false }, 'wrong action': { action: 'other' }, 'wrong host': { hostname: 'evil.example' }, 'rejected secret': { success: false, 'error-codes': ['invalid-input-secret'] } }))
    test(`Turnstile refuses ${name} before storing or sending`, async t => {
        const w = await world(t); turnstile(t, value);
        const response = await attempt(w, await begin(w));
        assert.equal(response.status, name === 'rejected secret' ? 503 : 400);
        assert.equal(w.mails.length, 0);
        assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM magic_links').get().n, 0);
    });
test('Turnstile accepted token cannot be reused even if siteverify says success', async t => {
    const w = await world(t); turnstile(t); const flow = await begin(w);
    assert.equal((await attempt(w, flow)).status, 200);
    assert.equal((await attempt(w, flow)).status, 400);
    assert.equal(w.mails.length, 1);
});
for (const value of ['', 'x'.repeat(2049)]) test(`Turnstile missing/oversized token (${value.length}) never calls provider`, async t => {
    const w = await world(t); const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not call'); });
    assert.equal((await attempt(w, await begin(w), value)).status, 400);
    assert.equal(network.mock.callCount(), 0);
});
for (const failure of ['network', 'http', 'malformed']) test(`Turnstile ${failure} outage permits existing user only`, async t => {
    const w = await world(t);
    w.env.DB.db.prepare("INSERT INTO users(id,email,email_verified,status,created) VALUES('known','person@example.com',1,'active',0)").run();
    t.mock.method(globalThis, 'fetch', async () => {
        if (failure === 'network') throw new Error('unavailable');
        return new Response('not json', { status: failure === 'http' ? 503 : 200 });
    });
    assert.equal((await attempt(w, await begin(w))).status, 200);
    assert.equal(w.mails.length, 1);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='turnstile_degraded'").get().n, 1);
});
test('degraded Turnstile never signs up a new or invited user', async t => {
    const w = await world(t);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unavailable'); });
    assert.equal((await attempt(w, await begin(w))).status, 200);
    assert.equal(w.mails.length, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM magic_links').get().n, 0);
});
test('degraded Turnstile refuses blocked users and caps requests per IP', async t => {
    const w = await world(t);
    w.env.DB.db.prepare("INSERT INTO users(id,email,email_verified,status,created) VALUES('blocked','person@example.com',1,'blocked',0)").run();
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('unavailable'); });
    const flow = await begin(w);
    for (let n = 0; n < 5; n++) assert.equal((await attempt(w, flow, `challenge-${n}`)).status, 200);
    const last = await attempt(w, flow, 'challenge-last');
    assert.equal(last.status, 429);
    assert.equal(w.mails.length, 0);
});
test('unconfigured Turnstile enables email without contacting siteverify', async t => {
    const w = await world(t); delete w.env.TURNSTILE_SECRET; delete w.env.TURNSTILE_SITE_KEY;
    const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected'); });
    const flow = await begin(w), html = await (await w.call('/login')).text();
    assert.match(html, /<button id="send-link" type="submit" value="link">/);
    assert.doesNotMatch(html, /cf-turnstile|challenges.cloudflare.com\/turnstile\/v0\/api.js/);
    assert.equal((await attempt(w, flow, '')).status, 200);
    assert.equal(w.mails.length, 1);
    assert.equal(network.mock.callCount(), 0);
});
test('partially configured Turnstile fails explicitly', async t => {
    const w = await world(t); delete w.env.TURNSTILE_SECRET;
    assert.equal((await attempt(w, await begin(w))).status, 503);
    assert.equal(w.mails.length, 0);
});
test('configured sign-in renders only the approved external script and widget', async t => {
    const w = await world(t), html = await (await w.call('/login')).text();
    assert.match(html, /<script src="https:\/\/challenges.cloudflare.com\/turnstile\/v0\/api.js" async defer><\/script>/);
    assert.match(html, /class="cf-turnstile" data-sitekey="test-site-key" data-action="sign_in"/);
    assert.match(html, /<button id="send-link" type="submit" value="link">/);
    assert.doesNotMatch(html, /<script nonce=|<script>(?:.|\n)*?<\/script>/);
});
for (const name of ['EMAIL', 'AUTH_LIMITER', 'API_LIMITER']) test(`missing ${name} is explicit failure`, async t => {
    const w = await world(t); const flow = await begin(w); delete w.env[name];
    const response = name === 'API_LIMITER' ? await w.call('/login') : await attempt(w, flow);
    assert.equal(response.status, 503);
});
test('rate binding refuses requests before any challenge or database sign-in state', async t => {
    const w = await world(t); const flow = await begin(w);
    w.env.AUTH_LIMITER.limit = async () => ({ success: false });
    assert.equal((await attempt(w, flow)).status, 429);
    assert.equal(w.mails.length, 0);
});
test('per email+IP budget is neutral and independent of address admission', async t => {
    const w = await world(t); turnstile(t); const flow = await begin(w);
    for (let n = 0; n < 7; n++) assert.equal((await attempt(w, flow, `challenge-${n}`)).status, 200);
    assert.equal(w.mails.length, 5);
});
