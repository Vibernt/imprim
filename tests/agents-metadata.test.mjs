import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, metadataId, metadata, resource, error } from './support/agents.mjs';
import { resolveAgent } from '../apps/server/src/agents/registration.mjs';
import { publicAddress, cacheLifetime, headerLifetime, CACHE_FLOOR_MS } from '../apps/server/src/agents/metadata-http.mjs';
import { scheduled } from '../apps/server/src/services/maintenance.mjs';

for (const host of ['127.0.0.1','127.1','2130706433','0x7f000001','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.0.1','[::1]','[::ffff:127.0.0.1]','[fc00::1]','[fe80::1]','localhost','host.localhost','host.local'])
    test(`metadata refuses SSRF literal or local name ${host}`, async t => {
        const w = await agentWorld(t);
        await error((await w.start({ client_id: `https://${host}/client.json` })).response, 'invalid_client_metadata');
        assert.equal(w.network.calls.length, 0);
    });

for (const address of ['127.0.0.1','10.0.0.1','172.31.255.255','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1'])
    test(`metadata refuses public DNS resolving to private/special address ${address}`, async t => {
        const w = await agentWorld(t); w.network.addresses = ['93.184.216.34', address];
        await error((await w.start()).response, 'invalid_client_metadata');
        assert.ok(w.network.calls.every(call => call.url.startsWith('https://cloudflare-dns.com/')));
    });

test('metadata rejects redirects without following them', async t => {
    const w = await agentWorld(t); w.network.status = 302;
    await error((await w.start()).response, 'invalid_client_metadata');
    assert.equal(w.network.calls.filter(call => call.url === metadataId).length, 1);
});

test('metadata enforces streamed 64 KiB cap even without Content-Length', async t => {
    const w = await agentWorld(t); w.network.document = { ...metadata, extra: 'x'.repeat(65536) };
    await error((await w.start()).response, 'invalid_client_metadata');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_metadata_cache').get().n, 0);
});

test('metadata timeout covers DNS and response body reads; failed request is not cached', async t => {
    const w = await agentWorld(t); let abortSignal;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        abortSignal = init.signal;
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const promise = resolveAgent(w.env, metadataId);
    // Let SQLite reads and fetch startup pass their microtask boundaries.
    for (let i = 0; i < 20 && !abortSignal; i++) await Promise.resolve();
    assert.ok(abortSignal); t.mock.timers.tick(5000);
    await assert.rejects(promise, /deadline/); assert.equal(abortSignal.aborted, true);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_metadata_cache').get().n, 0);
});

for (const change of [{ client_id: 'https://different.example/client.json' }, { client_name: '' }, { client_name: undefined }, { redirect_uris: [] }, { redirect_uris: ['http://evil.example/callback'] }, { redirect_uris: ['https://user:password@agent.example/callback'] }, { redirect_uris: ['https://agent.example/callback#fragment'] }, { token_endpoint_auth_method: 'client_secret_basic' }, { client_secret: 'secret' }, { grant_types: ['client_credentials'] }])
    test(`metadata validates document fields ${JSON.stringify(change)}`, async t => {
        const w = await agentWorld(t); w.network.document = { ...metadata, ...change };
        const response = (await w.start()).response;
        assert.ok(response.status >= 400); assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_metadata_cache').get().n, 0);
    });

test('metadata caches only HTTP freshness, expires without stale fallback, and bounds TTL', async t => {
    const w = await agentWorld(t);
    await resolveAgent(w.env, metadataId); const count = w.network.calls.length;
    await resolveAgent(w.env, metadataId); assert.equal(w.network.calls.length, count);
    w.env.DB.db.exec('UPDATE agent_metadata_cache SET expires_at=0');
    w.network.status = 503; await assert.rejects(resolveAgent(w.env, metadataId));
    // An uncacheable document is still held for the five-minute floor, so refreshes do not refetch it (S10).
    w.network.status = 200; w.network.cache = 'no-store';
    const before = w.network.calls.length;
    await resolveAgent(w.env, metadataId); await resolveAgent(w.env, metadataId);
    assert.equal(w.network.calls.filter(call => call.url === metadataId).length, w.network.calls.slice(0, before).filter(call => call.url === metadataId).length + 1);
    const held = w.env.DB.db.prepare('SELECT expires_at FROM agent_metadata_cache WHERE id=?').get(metadataId).expires_at - Date.now();
    assert.ok(held > CACHE_FLOOR_MS - 5000 && held <= CACHE_FLOOR_MS);
    const ttl = (headers, now) => headerLifetime(new Headers(headers), now);
    assert.equal(ttl({ 'cache-control': 'max-age=999999' }), 3600000);
    assert.equal(ttl({ 'cache-control': 'max-age=60', age: '30' }), 30000);
    for (const cc of ['no-cache, max-age=100', 'private, max-age=100', 'no-store', '']) assert.equal(ttl({ 'cache-control': cc }), 0);
    assert.equal(ttl({ expires: 'Wed, 04 Nov 2026 01:01:00 GMT', date: 'Wed, 04 Nov 2026 01:00:00 GMT' }, Date.parse('Wed, 04 Nov 2026 01:00:30 GMT')), 30000);
    assert.equal(cacheLifetime(new Headers({ 'cache-control': 'no-store' })), CACHE_FLOOR_MS);
    assert.equal(cacheLifetime(new Headers({ 'cache-control': 'max-age=999999' })), 3600000);
});

test('DCR is public only, rate limited per IP, and expiry removes unused clients after 30 days', async t => {
    const w = await agentWorld(t), body = { client_name: 'Unverified Agent', redirect_uris: ['http://localhost/cb'] };
    for (const change of [{ token_endpoint_auth_method: 'client_secret_basic' }, { client_secret: 'abc' }, { client_id: 'chosen' }])
        assert.equal((await w.post('/register', { ...body, ...change })).status, 400);
    const registered = await w.post('/register', body); assert.equal(registered.status, 201);
    const data = await registered.json(); assert.equal(data.token_endpoint_auth_method, 'none'); assert.equal(data.client_secret, undefined);
    const flow = await w.start({ client_id: data.client_id, redirect_uri: 'http://localhost:5555/cb' });
    assert.equal(flow.response.status, 303);
    const page = await w.call('/agent/consent?request_id=' + flow.id, { headers: { cookie: flow.cookie } }); assert.match(await page.text(), /<h1 class="fd-h1">Connect an unverified agent calling itself “Unverified Agent”\?<\/h1>/);
    for (let i = 0; i < 6; i++) assert.equal((await w.post('/register', body)).status, 201);
    await error(await w.post('/register', body), 'rate_limit', 429);
    assert.equal((await w.post('/register', body, '', { 'cf-connecting-ip': '203.0.113.2' })).status, 201);
    w.env.DB.db.prepare('UPDATE agent_clients SET last_used=? WHERE id=?').run(Date.now() - 30 * 86400000, data.client_id);
    await assert.rejects(resolveAgent(w.env, data.client_id));
    await scheduled(w.env);
    assert.equal(w.env.DB.db.prepare('SELECT * FROM agent_clients WHERE id=?').get(data.client_id), undefined);
});

test('dynamic agents obey per-app registration methods and allowlist', async t => {
    const w = await agentWorld(t), agent = await (await w.post('/register', { client_name: 'Dynamic', redirect_uris: ['http://127.0.0.1/callback'] })).json();
    const issued = await w.grant({ client_id: agent.client_id }); assert.ok(issued.tokens.access_token);
    for (const sql of [`agent_registration_methods='["metadata_document"]'`, `agent_registration_methods='["metadata_document","dynamic"]',agent_allowlist='["agent.example"]'`, "agent_allowlist='[]',agent_access='off'"]) {
        w.env.DB.db.exec(`UPDATE clients SET ${sql} WHERE id='app'`);
        await error((await w.start({ client_id: agent.client_id })).response, 'access_denied');
        await error(await w.refresh(issued.tokens.refresh_token, { client_id: agent.client_id }), 'access_denied');
    }
});

test('public address classifier rejects alternate families and allows global unicast', () => {
    for (const value of ['224.0.0.1','255.255.255.255','198.18.0.1','192.0.0.1','2002:7f00:1::','64:ff9b::7f00:1','::ffff:7f00:1','::']) assert.equal(publicAddress(value), false, value);
    for (const value of ['8.8.8.8','93.184.216.34','2606:4700:4700::1111']) assert.equal(publicAddress(value), true, value);
});

test('five-second metadata deadline also aborts a stalled response body', async t => {
    const w = await agentWorld(t); let started = false, signal;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const original = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (url !== metadataId) return original(url, init);
        signal = init.signal;
        return new Response(new ReadableStream({ start(controller) {
            started = true;
            signal.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
        } }), { headers: { 'content-type': 'application/json' } });
    });
    const promise = resolveAgent(w.env, metadataId);
    for (let i = 0; i < 100 && !started; i++) await Promise.resolve();
    assert.ok(started); t.mock.timers.tick(5000);
    await assert.rejects(promise, /deadline/); assert.equal(signal.aborted, true);
});

test('declared oversize and non-JSON responses are rejected and canceled', async t => {
    const w = await agentWorld(t), original = globalThis.fetch;
    let contentType = 'application/json', length = '65537', cancelled = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => url === metadataId
        ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': contentType, 'content-length': length } })
        : original(url, init));
    await assert.rejects(resolveAgent(w.env, metadataId), /size limit/);
    contentType = 'text/html'; length = '100';
    await assert.rejects(resolveAgent(w.env, metadataId), /application\/json/);
    assert.equal(cancelled, 2);
});

test('DNS dependency errors stop before metadata HTTPS and never use stale documents', async t => {
    const w = await agentWorld(t); let docCalls = 0;
    t.mock.method(globalThis, 'fetch', async url => {
        if (String(url).startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 2 });
        docCalls++; throw Error('must not fetch document');
    });
    await assert.rejects(resolveAgent(w.env, metadataId), /DNS resolution failed/);
    assert.equal(docCalls, 0);
});
