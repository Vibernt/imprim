// Negative tests for the security pass of 2026-11-15 (findings S1–S19 and hygiene items).
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, turnstile, begin, basic } from './support/world.mjs';
import { agentWorld, metadataId, resource, metadata, error } from './support/agents.mjs';
import { adminLogin, clientConfig } from './support/admin.mjs';
import { clientAddress } from '../apps/server/src/auth/rate-limit.mjs';
import { limiterFor } from '../apps/server/src/worker.mjs';
import { sweepGrants, SPENT_REFRESH_KEEP_MS, ENDED_GRANT_KEEP_MS } from '../apps/server/src/services/maintenance.mjs';
import { MAX_LIVE_GRANTS } from '../apps/server/src/agents/consent.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function keyPair() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { ...pair, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: 'k1' } };
}
async function assertion(pair, claims = {}, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'ES256', kid: 'k1', typ: 'JWT', ...header })}.${b64({ iss: metadataId, sub: metadataId, aud: 'https://id.example.com/token', exp: now + 120, jti: crypto.randomUUID(), ...claims })}`;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
}
const ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

// S1: device flow, claimed identity and key-bound agents.
test('S1: a metadata document without grant_types cannot start a device flow', async t => {
    const w = await agentWorld(t);
    const { grant_types, ...plain } = metadata;
    w.network.document = plain;
    await error(await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' }), 'unauthorized_client');
});
test('S1: device and loopback consents say the agent host is claimed and warn about remote phishing', async t => {
    const w = await agentWorld(t);
    const loopback = await w.start();
    const html = await (await w.call(`/agent/consent?request_id=${loopback.id}`, { headers: { cookie: loopback.cookie } })).text();
    assert.match(html, /<h1 class="fd-h1">Connect an agent calling itself “Example Agent”\?<\/h1>/);
    assert.match(html, /claimed, not verified/);
    assert.match(html, /<div class="fd-callout" data-tone="danger" role="alert">.*If someone sent you this link or code, choose Deny/s);
    const https = await w.start({ redirect_uri: 'https://agent.example/callback' });
    const verified = await (await w.call(`/agent/consent?request_id=${https.id}`, { headers: { cookie: https.cookie } })).text();
    assert.match(verified, /verified by its HTTPS callback/);
    assert.doesNotMatch(verified, /role="alert"/);
    assert.match(html, /<form method="post" action="\/agent\/consent"><input type="hidden" name="request_id" value="[^"]+"><input type="hidden" name="csrf" value="[^"]+">/);
    assert.match(html, /<button class="fd-btn" type="submit" data-variant="outline" name="decision" value="deny"><span>Deny<\/span><\/button><button class="fd-btn" type="submit" data-variant="primary" name="decision" value="approve"><span>Approve<\/span><\/button>/);
    assert.equal((html.match(/data-variant="primary"/g) || []).length, 1);
    assert.doesNotMatch(verified, /claimed, not verified/);
});
test('S1: a key-bound agent must sign every token request; a claimed client_id alone gets nothing', async t => {
    const w = await agentWorld(t), pair = await keyPair();
    w.network.document = { ...metadata, token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [pair.jwk] } };
    // Device flow: an impostor without the key cannot even obtain a user code.
    await error(await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' }), 'invalid_client', 401);
    const device = await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read', client_assertion_type: ASSERTION,
        client_assertion: await assertion(pair, { aud: 'https://id.example.com/device_authorization' }) });
    assert.equal(device.status, 200, await device.clone().text());
    // Code flow: consent says the host is verified by key, and the code is useless without an assertion.
    const flow = await w.start();
    assert.match(await (await w.call(`/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie } })).text(), /verified by its signing key/);
    const code = new URL((await w.approve(flow)).headers.get('location')).searchParams.get('code');
    await error(await w.exchange(code), 'invalid_client', 401);
    const signed = await assertion(pair);
    const ok = await w.exchange(code, { client_assertion_type: ASSERTION, client_assertion: signed });
    assert.equal(ok.status, 200, await ok.clone().text());
    const tokens = await ok.json();
    // Single use: a replayed assertion is refused even on a new request.
    await error(await w.refresh(tokens.refresh_token, { client_assertion_type: ASSERTION, client_assertion: signed }), 'invalid_client', 401);
    for (const claims of [{ aud: 'https://evil.example/token' }, { iss: 'https://other.example/client.json' }, { exp: Math.floor(Date.now() / 1000) + 3600 }, { exp: Math.floor(Date.now() / 1000) - 1 }, { jti: undefined }])
        await error(await w.refresh(tokens.refresh_token, { client_assertion_type: ASSERTION, client_assertion: await assertion(pair, claims) }), 'invalid_client', 401);
    const other = await keyPair();
    await error(await w.refresh(tokens.refresh_token, { client_assertion_type: ASSERTION, client_assertion: await assertion(other) }), 'invalid_client', 401);
    await error(await w.refresh(tokens.refresh_token, { client_assertion_type: ASSERTION, client_assertion: await assertion(pair, {}, { alg: 'none' }) }), 'invalid_client', 401);
    const refreshed = await w.refresh(tokens.refresh_token, { client_assertion_type: ASSERTION, client_assertion: await assertion(pair) });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
});
test('S1: keys are refused for dynamic registration, private keys and foreign jwks_uri hosts', async t => {
    const w = await agentWorld(t), pair = await keyPair();
    const dynamic = await w.post('/register', { client_name: 'X', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [pair.jwk] } });
    assert.equal(dynamic.status, 400);
    for (const document of [
        { ...metadata, token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [{ ...pair.jwk, d: 'secret' }] } },
        { ...metadata, token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://elsewhere.example/jwks.json' },
        { ...metadata, jwks: { keys: [pair.jwk] } }]) {
        w.network.document = document;
        w.env.DB.db.exec('DELETE FROM agent_metadata_cache');
        await error(await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' }), 'invalid_client_metadata');
    }
    w.network.document = metadata;
    w.env.DB.db.exec('DELETE FROM agent_metadata_cache');
    await error(await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read', client_assertion_type: ASSERTION, client_assertion: await assertion(pair) }), 'invalid_client', 401);
});

// S2: public metadata is unlimited; /token is limited per authenticated client.
test('S2: discovery and JWKS skip the address limiter; /token spends the client budget, failed auth the address budget', async t => {
    for (const path of ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server', '/.well-known/jwks.json']) assert.equal(limiterFor('GET', path), null);
    assert.equal(limiterFor('POST', '/token'), null);
    assert.equal(limiterFor('POST', '/v1/auth/magic/request'), 'AUTH_LIMITER');
    assert.equal(limiterFor('GET', '/authorize'), 'API_LIMITER');
    const w = await world(t), keys = [];
    w.env.API_LIMITER = { async limit({ key }) { keys.push(key); return { success: true }; } };
    assert.equal((await w.call('/.well-known/jwks.json')).status, 200);
    assert.equal(keys.length, 0);
    const { code } = await login(w, t);
    assert.equal((await w.exchange(code)).status, 200);
    const { sha256 } = await import('../apps/server/src/lib/crypto.mjs');
    assert.ok(keys.includes(await sha256('client:app')));
    keys.length = 0;
    assert.equal((await w.exchange('x'.repeat(43), {}, basic('app', 'wrong'))).status, 401);
    assert.deepEqual(keys, [await sha256('ip:unavailable')]);
});

// S3 is covered in magic.test.mjs and google.test.mjs; S4 in github.test.mjs and google.test.mjs.

// S5: bounded growth.
test('S5: the sweep deletes old spent refresh tokens and ended grants, and keeps recent evidence', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    await w.refresh(tokens.refresh_token);
    const now = Date.now();
    await sweepGrants(w.env, now);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_refresh_tokens WHERE spent_at IS NOT NULL').get().n, 1);
    await sweepGrants(w.env, now + SPENT_REFRESH_KEEP_MS + 1);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_refresh_tokens WHERE spent_at IS NOT NULL').get().n, 0);
    w.env.DB.db.prepare('UPDATE agent_grants SET revoked_at=?').run(now);
    await sweepGrants(w.env, now + ENDED_GRANT_KEEP_MS - 1);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 1);
    await sweepGrants(w.env, now + ENDED_GRANT_KEEP_MS + 1);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_refresh_tokens').get().n, 0);
});
test('S5: audit rows inside the 400-day retention cannot be deleted; older rows can', async t => {
    const w = await world(t);
    w.env.DB.db.prepare("INSERT INTO audit(event,detail,created) VALUES('recent','{}',?)").run(Date.now());
    w.env.DB.db.prepare("INSERT INTO audit(event,detail,created) VALUES('ancient','{}',?)").run(Date.now() - 401 * 86400000);
    assert.throws(() => w.env.DB.db.exec("DELETE FROM audit WHERE event='recent'"), /append-only/);
    assert.throws(() => w.env.DB.db.exec("UPDATE audit SET event='x'"), /append-only/);
    w.env.DB.db.exec("DELETE FROM audit WHERE event='ancient'");
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM audit').get().n, 1);
});
test('S5: /account pages connected agents and a person cannot hold more than the live-grant cap', async t => {
    const w = await agentWorld(t); await w.grant();
    const grant = w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    const insert = w.env.DB.db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 1; i <= MAX_LIVE_GRANTS; i++) insert.run(crypto.randomUUID(), grant.client_id, 'Filler', 'metadata_document', 'app', grant.user_id, resource, 'read', 'email', grant.created - i, grant.created, grant.expires_at);
    const read = async query => {
        const response = await w.call(`/v1/account/agents${query}`, { headers: { cookie: w.cookie } });
        assert.equal(response.status, 200);
        return response.json();
    };
    const page = await read('');
    assert.equal(page.agents.length, 50);
    assert.ok(page.agents.every(agent => agent.status === 'active'));
    assert.ok(page.next);
    const older = await read(`?before=${encodeURIComponent(page.next)}`);
    assert.equal(older.agents.length, MAX_LIVE_GRANTS + 1 - 50);
    assert.ok(older.agents.every(agent => !page.agents.some(first => first.id === agent.id)));
    const flow = await w.start();
    await error(await w.approve(flow), 'access_denied', 403);
    await error(await w.call('/v1/account/agents?before=junk', { headers: { cookie: w.cookie } }), 'invalid_request');
});

// S7, S8: user codes use all 20 letters; budgets key on the IPv6 /64 and on the recipient.
test('S7: IPv6 budgets key on the /64; IPv4 stays exact', () => {
    const request = ip => new Request('https://id.example.com/', { headers: { 'cf-connecting-ip': ip } });
    assert.equal(clientAddress(request('2001:db8:1:2:3:4:5:6')), clientAddress(request('2001:db8:1:2:ffff::1')));
    assert.notEqual(clientAddress(request('2001:db8:1:2::1')), clientAddress(request('2001:db8:1:3::1')));
    assert.equal(clientAddress(request('2001:0db8:0001:0002::')), '2001:db8:1:2::/64');
    assert.equal(clientAddress(request('203.0.113.9')), '203.0.113.9');
});
test('S7: device user codes can contain every letter of the alphabet, including Z', async t => {
    const w = await agentWorld(t);
    const original = crypto.getRandomValues.bind(crypto);
    t.mock.method(crypto, 'getRandomValues', array => array.length === 1 ? (array[0] = 19, array) : original(array));
    const device = await (await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' })).json();
    assert.equal(device.user_code, 'ZZZZ-ZZZZ');
    t.mock.restoreAll();
});
test('S8: one recipient gets at most five sign-in emails an hour, whatever the source address', async t => {
    const w = await world(t, 'open'); turnstile(t);
    for (let i = 0; i < 8; i++) {
        const flow = await begin(w);
        await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, flow.cookie, { 'cf-connecting-ip': `2001:db8:${i}::1` });
    }
    await w.drain();
    assert.equal(w.mails.length, 5);
});

// S9, S10, S11: allowlist host, ports, budgets and confusable names.
test('S9: a host allowlist entry never admits another port on the same name', async t => {
    const w = await agentWorld(t);
    w.env.DB.db.exec(`UPDATE clients SET agent_allowlist='["agent.example"]' WHERE id='app'`);
    const { checkPolicy } = await import('../apps/server/src/agents/policy.mjs');
    await assert.rejects(checkPolicy(w.env, { client_id: 'https://agent.example:8443/client.json', resource, scope: 'read' }), error => ['access_denied', 'invalid_client_metadata'].includes(error.code));
    assert.ok(await checkPolicy(w.env, { client_id: metadataId, resource, scope: 'read' }));
});
test('S10: metadata URLs on non-443 ports are refused before any fetch; /authorize has an agent budget', async t => {
    const w = await agentWorld(t);
    const before = w.network.calls.length;
    const response = await w.call('/authorize?' + new URLSearchParams(await w.query({ client_id: 'https://agent.example:8443/client.json' })), { headers: { cookie: w.cookie } });
    assert.equal(response.status, 400);
    assert.equal(w.network.calls.length, before);
    for (let i = 0; i < 59; i++) await w.call('/authorize?' + new URLSearchParams(await w.query()), { headers: { cookie: w.cookie } });
    assert.equal((await w.call('/authorize?' + new URLSearchParams(await w.query()), { headers: { cookie: w.cookie } })).status, 429);
});
test('S11: bidirectional and invisible characters are stripped from agent names', async t => {
    const w = await agentWorld(t);
    w.network.document = { ...metadata, client_name: 'Cla‮edu‬​' };
    const flow = await w.start();
    const html = await (await w.call(`/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie } })).text();
    assert.ok(html.includes('Claedu'));
    assert.ok(!/[‪-‮​]/.test(html));
    w.network.document = { ...metadata, client_name: '‮​' };
    w.env.DB.db.exec('DELETE FROM agent_metadata_cache');
    assert.equal((await w.call('/authorize?' + new URLSearchParams(await w.query()), { headers: { cookie: w.cookie } })).status, 400);
});

// S12, S14: admin.
test('S12: turning agent access off revokes and notifies every live grant; turning it on revives none', async t => {
    const w = await agentWorld(t); // agentWorld's network fake also answers Turnstile.
    const { tokens } = await w.grant();
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel', redirect_uris='[\"https://app.example/callback\"]' WHERE id='app'");
    const admin = await adminLogin(w);
    const current = await (await admin.get('clients/app')).json();
    const saved = await admin.post('clients/app', { agent_access: 'off', version: current.version });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_revocation_outbox').get().n, 1);
    const again = await (await admin.get('clients/app')).json();
    assert.equal((await admin.post('clients/app', { agent_access: 'on', version: again.version })).status, 200);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
});
test('S14: creating or editing a client requires a sign-in within ten minutes', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    w.env.DB.db.exec('UPDATE sessions SET auth_time=0');
    await error(await admin.post('clients', clientConfig), 'reauth_required', 403);
});

// S18, S19 and hygiene.
test('S18: the relying-party client refuses a callback without iss', async t => {
    const w = await world(t);
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', clientSecret: 'secret', redirectUri: 'https://app.example/callback', fetch: (url, init) => w.call(new URL(url).pathname, init) });
    const login = await client.startLogin();
    await assert.rejects(client.handleCallback(`https://app.example/callback?code=x&state=${login.state}`, login), error => error.code === 'invalid_issuer');
    const failed = client.handleCallback(`https://app.example/callback?error=access_denied&error_description=%3Cscript%3E&state=${login.state}&iss=${encodeURIComponent(w.env.ISSUER)}`, login);
    await assert.rejects(failed, error => error.code === 'access_denied' && error.message === 'Authorization failed.' && error.description === '<script>');
});
test('hygiene: a failed discovery is not cached', async () => {
    let calls = 0;
    const client = createClient({ issuer: 'https://id.example.com', clientId: 'app', redirectUri: 'https://app.example/callback', fetch: async () => {
        calls++;
        if (calls === 1) throw new Error('offline');
        return Response.json({ issuer: 'https://id.example.com', id_token_signing_alg_values_supported: ['ES256'], code_challenge_methods_supported: ['S256'],
            authorization_endpoint: 'https://id.example.com/authorize', token_endpoint: 'https://id.example.com/token', jwks_uri: 'https://id.example.com/.well-known/jwks.json', end_session_endpoint: 'https://id.example.com/logout' });
    } });
    await assert.rejects(client.startLogin(), error => error.code === 'network');
    assert.ok((await client.startLogin()).url.startsWith('https://id.example.com/authorize?'));
});
test('S19: duplicate cookies for other names are ignored; duplicates of identity cookies are refused', async t => {
    const w = await world(t), { cookie } = await login(w, t);
    const ok = await w.call('/signed-in', { headers: { cookie: `${cookie}; theme=dark; theme=light` } });
    assert.equal(ok.status, 200);
    const session = cookie.match(/__Host-vi_session=[^;]+/)[0];
    assert.equal((await w.call('/signed-in', { headers: { cookie: `${cookie}; ${session}` } })).status, 400);
});
test('hygiene: the ID token carries email claims only with the email scope', async t => {
    const w = await world(t);
    turnstile(t);
    const flow = await (async () => {
        const response = await w.authorize({ scope: 'openid' });
        return { cookie: response.headers.getSetCookie().map(x => x.split(';')[0]).join('; '), request_id: (await response.text()).match(/data-request-id="([^"]+)"/)[1] };
    })();
    await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, flow.cookie);
    await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const verified = await w.post('/v1/auth/magic/verify', { token }, flow.cookie);
    const code = new URL(verified.headers.get('location')).searchParams.get('code');
    const body = await (await w.exchange(code)).json();
    const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url'));
    assert.equal(claims.email, undefined);
    assert.equal(claims.email_verified, undefined);
});

test('hygiene: a resource has one canonical form, so one route never has several audiences', async () => {
    const { resourceUrl, underPrefix } = await import('../apps/server/src/agents/uris.mjs');
    for (const value of ['https://app.example/w/team/mcp/', 'https://app.example/w/%74eam/mcp', 'https://app.example/w/te%2aam/mcp', 'https://app.example/w//team/mcp', 'https://app.example/w/team/%7Emcp'])
        assert.throws(() => resourceUrl(value), error => error.code === 'invalid_target', value);
    assert.ok(resourceUrl('https://app.example/w/te%2Aam/mcp'));
    assert.ok(resourceUrl('https://app.example/w/', 'prefix'));
    assert.ok(underPrefix('https://app.example/w/team/mcp', 'https://app.example/w/'));
});

// Review findings on the security pass.
test('review 1: a public client is named by a bare client_id, so its /token calls never spend the app budget', async t => {
    const w = await world(t), keys = [];
    w.env.DB.db.exec("UPDATE clients SET secret_hash=NULL WHERE id='app'");
    w.env.API_LIMITER = { async limit({ key }) { keys.push(key); return { success: true }; } };
    const { sha256 } = await import('../apps/server/src/lib/crypto.mjs');
    const response = await w.call('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'app', code: 'x'.repeat(43), redirect_uri: 'https://app.example/callback', code_verifier: 'v'.repeat(43) }) });
    assert.equal(response.status, 400);
    assert.ok(!keys.includes(await sha256('client:app')));
    assert.ok(keys.includes(await sha256('ip:unavailable')));
});
test('review 2: the refresh admission fence checks the grant holder, not any admitted user', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('someone','someone@example.com',0); INSERT INTO client_admissions(user_id,client_id,created) VALUES('someone','app',0)");
    w.env.DB.db.prepare('DELETE FROM client_admissions WHERE user_id=?').run(w.user.id);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
});
test('review 3: a provider cannot create an account on a stale email that the mailbox owner later inherits', async t => {
    const w = await world(t, 'open');
    const github = async () => {
        t.mock.method(globalThis, 'fetch', async url => {
            if (url.endsWith('/access_token')) return Response.json({ access_token: 'provider-token' });
            if (url.endsWith('/user')) return Response.json({ id: 99, login: 'attacker' });
            if (url.includes('/user/emails')) return Response.json([{ email: 'person@example.com', primary: true, verified: true }]);
            if (url.includes('challenges.cloudflare.com')) return Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' });
            throw new Error('unexpected network');
        });
        const flow = await begin(w);
        const start = await w.call(`/v1/auth/github/start?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } });
        const jar = flow.cookie + '; ' + start.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
        return w.call('/auth/github/callback?' + new URLSearchParams({ code: 'github-code', state: new URL(start.headers.get('location')).searchParams.get('state') }), { headers: { cookie: jar } });
    };
    assert.equal((await github()).status, 303);
    const user = w.env.DB.db.prepare('SELECT * FROM users').get();
    assert.equal(user.email_verified, 0, 'a provider flag is not mailbox proof');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 1);
    // The mailbox owner signs in by email link: the GitHub link and its sessions end, the account is theirs.
    const owner = await login(w, t);
    assert.equal(owner.response.status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM user_identities').get().n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 1);
    assert.equal(w.env.DB.db.prepare('SELECT email_verified FROM users').get().email_verified, 1);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='mailbox_claimed'").get().n, 1);
});
test('review 4: a leaked code or spent token cannot revoke a key-bound agent without its key', async t => {
    const w = await agentWorld(t), pair = await keyPair();
    w.network.document = { ...metadata, token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [pair.jwk] } };
    const flow = await w.start();
    const code = new URL((await w.approve(flow)).headers.get('location')).searchParams.get('code');
    const tokens = await (await w.exchange(code, { client_assertion_type: ASSERTION, client_assertion: await assertion(pair) })).json();
    const next = await (await w.refresh(tokens.refresh_token, { client_assertion_type: ASSERTION, client_assertion: await assertion(pair) })).json();
    w.env.DB.db.prepare('UPDATE agent_refresh_tokens SET spent_at=spent_at-60000 WHERE spent_at IS NOT NULL').run();
    await error(await w.exchange(code), 'invalid_client', 401);
    await error(await w.refresh(tokens.refresh_token), 'invalid_client', 401);
    assert.equal(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at, null);
    // With the key, reuse is still detected and revokes.
    await error(await w.refresh(tokens.refresh_token, { client_assertion_type: ASSERTION, client_assertion: await assertion(pair) }), 'invalid_grant');
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.ok(next.refresh_token);
});
test('review 6: a malformed key envelope retires the key instead of blocking signing', async t => {
    const w = await world(t);
    const { signingKey } = await import('../apps/server/src/oidc/keys.mjs');
    const first = await signingKey(w.env);
    w.env.DB.db.prepare('UPDATE signing_keys SET sealed_jwk=? WHERE kid=?').run(JSON.stringify({ version: 1, iv: '!!', ciphertext: '' }), first.kid);
    const next = await signingKey(w.env);
    assert.notEqual(next.kid, first.kid);
});
