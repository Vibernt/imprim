import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { fakeGoogle, googleCallback, googleJwk } from './support/google.mjs';
const keyCalls = fake => fake.calls.filter(call => call.url.endsWith('/certs')).length;
test('Google caches public JWKS and refreshes once for a rotated kid', async t => {
    const w = await world(t), fake = fakeGoogle(t, w);
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
    assert.equal((await googleCallback(w, await fake.start())).status, 303); assert.equal(keyCalls(fake), 1);
    fake.config.header = { kid: 'rotated' }; fake.config.jwks = { keys: [{ ...googleJwk, kid: 'rotated' }] };
    assert.equal((await googleCallback(w, await fake.start())).status, 303); assert.equal(keyCalls(fake), 2);
    fake.config.header = { kid: 'unknown' };
    assert.equal((await googleCallback(w, await fake.start())).status, 401); assert.equal(keyCalls(fake), 3);
});
for (const cacheControl of ['public, max-age=0', 'no-store', 'no-cache, max-age=3600', '']) test(`Google respects JWKS caching directive ${cacheControl}`, async t => {
    const w = await world(t), fake = fakeGoogle(t, w); fake.config.cacheControl = cacheControl;
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
    assert.equal((await googleCallback(w, await fake.start())).status, 303); assert.equal(keyCalls(fake), 2);
});
test('expired JWKS must refresh successfully; cached keys never mask an outage', async t => {
    const w = await world(t), fake = fakeGoogle(t, w); fake.config.cacheControl = 'max-age=1';
    assert.equal((await googleCallback(w, await fake.start())).status, 303);
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 2000);
    const flow = await fake.start(), fetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, init) => url.endsWith('/certs') ? new Response('down', { status: 503 }) : fetch(url, init));
    assert.equal((await googleCallback(w, flow)).status, 502);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 1);
});
for (const key of [{ ...googleJwk, alg: 'HS256' }, { ...googleJwk, use: 'enc' }, { ...googleJwk, kty: 'oct' }, { ...googleJwk, d: 'private' }, { ...googleJwk, key_ops: ['sign'] }])
    test(`Google refuses incompatible JWKS ${JSON.stringify({ alg: key.alg, use: key.use, kty: key.kty, private: !!key.d, ops: key.key_ops })}`, async t => {
        const w = await world(t), fake = fakeGoogle(t, w); fake.config.jwks = { keys: [key] };
        assert.equal((await googleCallback(w, await fake.start())).status, 401);
        assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    });
for (const kind of ['token outage', 'JWKS outage', 'redirect', 'malformed JSON', 'oversized JSON', 'missing ID token', 'invalid signature', 'malformed signature', 'empty JWKS', 'malformed JWKS entry', 'duplicate kid', 'key URL'])
    test(`Google rejects ${kind} without sessions and spends state`, async t => {
        const w = await world(t), fake = fakeGoogle(t, w), flow = await fake.start(), fetch = globalThis.fetch;
        if (kind === 'empty JWKS') fake.config.jwks = { keys: [] };
        if (kind === 'malformed JWKS entry') fake.config.jwks = { keys: [null] };
        if (kind === 'duplicate kid') fake.config.jwks = { keys: [googleJwk, googleJwk] };
        if (kind === 'key URL') fake.config.header = { jku: 'https://evil.example/keys' };
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            if (kind === 'token outage') throw new Error('connection failed');
            if (kind === 'JWKS outage' && url.endsWith('/certs')) return new Response('down', { status: 503 });
            if (kind === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
            if (kind === 'malformed JSON') return new Response('bad json');
            if (kind === 'oversized JSON') return new Response('x'.repeat(65537));
            if (kind === 'missing ID token') return Response.json({ access_token: 'unused' });
            const response = await fetch(url, init);
            if (kind.includes('signature') && url.endsWith('/token')) {
                const data = await response.json(), pieces = data.id_token.split('.');
                pieces[2] = kind === 'malformed signature' ? 'x' : Buffer.alloc(256).toString('base64url');
                return Response.json({ ...data, id_token: pieces.join('.') });
            }
            return response;
        });
        const response = await googleCallback(w, flow);
        assert.ok([401,502].includes(response.status), `${kind}: ${response.status}`);
        assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
        assert.equal((await googleCallback(w, flow)).status, 401);
    });
