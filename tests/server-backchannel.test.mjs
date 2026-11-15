import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { agentWorld, resource } from './support/agents.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';
import { deliverLogout, logoutStatements } from '../apps/server/src/oidc/backchannel.mjs';
import { deliverRevocation, revokeGrant } from '../apps/server/src/agents/revocation.mjs';
import { queue } from '../apps/server/src/services/maintenance.mjs';
import { dispatchOutbox } from '../apps/server/src/services/outbox.mjs';
import { deliveryWindowMs } from '../apps/server/src/services/outbox-expiry.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { adminLogin } from './support/admin.mjs';
const destination = 'https://app.example/backchannel';
const decode = token => token.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url')));
const options = w => ({ issuer: w.env.ISSUER, clientId: 'app', redirectUri: 'https://app.example/callback', resourcePrefixes: ['https://app.example/w/'], fetch: url => w.call(new URL(url).pathname) });
async function pending(t, kind) {
    const w = await agentWorld(t);
    w.env.DB.db.prepare('UPDATE clients SET backchannel_uri=?').run(destination);
    if (kind === 'logout') {
        w.env.DB.db.prepare('INSERT INTO app_sessions VALUES(?,?,?,?)').run('app', w.user.id, w.signed.session.sid, Date.now());
        await w.env.DB.batch(logoutStatements(w.env, w.user.id));
    } else {
        w.tokens = (await w.grant()).tokens;
        w.grantId = w.env.DB.db.prepare('SELECT id FROM agent_grants').get().id;
        await revokeGrant(w.env, w.grantId, w.user.id);
    }
    const table = kind === 'logout' ? 'logout_outbox' : 'agent_revocation_outbox';
    const row = w.env.DB.db.prepare(`SELECT * FROM ${table}`).get();
    return { w, row, table, deliver: kind === 'logout' ? deliverLogout : deliverRevocation, message: { body: { type: kind === 'logout' ? 'human_logout' : 'agent_revocation', event_id: row.id } } };
}
for (const kind of ['logout', 'revocation']) test(`server ${kind} token passes source and vendored client and exact app wire contract`, async t => {
    const { w, row, deliver, message } = await pending(t, kind);
    const vendor = await import('../dist/imprim-client.mjs');
    const clients = [createClient(options(w)), vendor.createClient(options(w))];
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (uri, init) => {
        calls++;
        assert.equal(uri, destination); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
        assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded'); assert.ok(init.signal instanceof AbortSignal);
        const form = new URLSearchParams(init.body), token = form.get(kind + '_token'), [header, claims] = decode(token);
        assert.deepEqual([...form.keys()], [kind + '_token']);
        assert.equal(header.alg, 'ES256'); assert.equal(header.typ, kind === 'logout' ? 'logout+jwt' : 'secevent+jwt');
        assert.ok((await (await w.call('/.well-known/jwks.json')).json()).keys.some(key => key.kid === header.kid));
        assert.equal(claims.iss, w.env.ISSUER); assert.equal(claims.aud, 'app'); assert.equal(claims.sub, w.user.id);
        assert.equal(claims.jti, row.id); assert.equal(claims.exp - claims.iat, kind === 'logout' ? 120 : 300);
        assert.ok(Number.isInteger(claims.iat)); assert.ok(claims.exp - claims.iat <= 900); assert.equal(Object.hasOwn(claims, 'nonce'), false);
        assert.deepEqual(claims.events, { [kind === 'logout' ? 'http://schemas.openid.net/event/backchannel-logout' : 'https://id.vibernt.ai/events/agent-revoked']: {} });
        for (const client of clients) {
            const event = await client.verifyBackchannel(form);
            assert.equal(event.kind, kind); assert.equal(event.claims.sub, w.user.id);
            if (kind === 'revocation') {
                assert.equal((await client.verifyRevocationToken(token)).grantId, row.grant_id);
                assert.equal(event.claims.resource, resource);
            } else assert.equal((await client.verifyLogoutToken(token)).sid, w.signed.session.sid);
        }
        // Opt-in check against an app's vendored copy of the client (IMPRIM_CLIENT_PATH); no cross-repository dependency in CI.
        if (kind === 'logout' && process.env.IMPRIM_CLIENT_PATH) {
            const vendored = await import(pathToFileURL(process.env.IMPRIM_CLIENT_PATH));
            const verified = await vendored.createClient(options(w)).handleBackchannelLogout(new Request(uri, { method: 'POST', body: form }));
            assert.equal(verified.sub, w.user.id); assert.equal(verified.jti, row.id);
        }
        return new Response(null, { status: 204 });
    });
    await deliver(w.env, message); await deliver(w.env, message); assert.equal(calls, 1);
});

for (const kind of ['logout','revocation']) test(`${kind} redirect, non-2xx and timeout retry without marking delivery`, async t => {
    const { w, table, message } = await pending(t, kind);
    let retries = 0, acknowledgements = 0;
    message.retry = () => { retries++; }; message.ack = () => { acknowledgements++; };
    for (const status of [302,400,503,'timeout']) {
        t.mock.method(globalThis, 'fetch', async () => {
            if (status === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
            return new Response(null, { status, headers: status === 302 ? { location: 'https://evil.example' } : {} });
        });
        await queue({ messages: [message] }, w.env);
        assert.equal(w.env.DB.db.prepare(`SELECT delivered_at FROM ${table}`).get().delivered_at, null);
    }
    assert.equal(retries, 4); assert.equal(acknowledgements, 0);
    const config = await readFile(new URL('../apps/server/wrangler.jsonc', import.meta.url), 'utf8');
    assert.match(config, /"max_retries": 5, "dead_letter_queue": "vibernt-identity-logout-dlq"/);
});

test('receiver denies exactly the revoked grant immediately and offline verification expires within 60 seconds', async t => {
    const { w, row, deliver, message } = await pending(t, 'revocation');
    const client = createClient(options(w)), other = (await w.grant()).tokens;
    w.env.DB.db.exec('CREATE TABLE receiver_events(jti TEXT PRIMARY KEY); CREATE TABLE receiver_denials(sub TEXT,resource TEXT,grant_id TEXT,PRIMARY KEY(sub,resource,grant_id))');
    const accepted = async token => {
        const claims = await client.verifyAccessToken(token, { audience: resource });
        return !w.env.DB.db.prepare('SELECT 1 FROM receiver_denials WHERE sub=? AND resource=? AND grant_id=?').get(claims.sub, claims.aud, claims.grant_id);
    };
    assert.equal(await accepted(w.tokens.access_token), true); // Before back-channel arrival, signature still valid.
    t.mock.method(globalThis, 'fetch', async (uri, init) => {
        const { claims } = await client.verifyBackchannel(new URLSearchParams(init.body));
        await w.env.DB.batch([
            w.env.DB.prepare('INSERT OR IGNORE INTO receiver_events VALUES(?)').bind(claims.jti),
            w.env.DB.prepare('INSERT OR IGNORE INTO receiver_denials SELECT ?,?,? WHERE changes()=1').bind(claims.sub, claims.resource, claims.grantId)
        ]);
        return new Response(null, { status: 204 });
    });
    await deliver(w.env, message);
    w.env.DB.db.prepare('UPDATE agent_revocation_outbox SET delivered_at=NULL WHERE id=?').run(row.id);
    await deliver(w.env, message);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM receiver_events').get().n, 1);
    assert.equal(await accepted(w.tokens.access_token), false); assert.equal(await accepted(other.access_token), true);
    assert.equal((await w.refresh(w.tokens.refresh_token)).status, 400);
    const claims = await client.verifyAccessToken(w.tokens.access_token, { audience: resource });
    assert.equal(claims.grant_id, row.grant_id); assert.equal(claims.exp - claims.iat, 60);
    t.mock.method(Date, 'now', () => claims.exp * 1000);
    await assert.rejects(client.verifyAccessToken(w.tokens.access_token, { audience: resource }), /Invalid access-token/);
});

test('admin session revocation captures only selected sid for each app and audits atomically', async t => {
    const w = await agentWorld(t), admin = await adminLogin(w), second = await issueSession(w.env, w.user, 'email');
    await w.grant();
    for (const sid of [w.signed.session.sid, second.session.sid]) for (const id of ['app','other'])
        w.env.DB.db.prepare('INSERT INTO app_sessions VALUES(?,?,?,?)').run(id, w.user.id, sid, Date.now());
    const page = await w.call('/admin/users/' + w.user.id, { headers: { cookie: admin.cookie } });
    assert.match(await page.text(), /revoke-session/);
    assert.equal((await admin.post(`users/${w.user.id}/revoke-session`, { sid: w.signed.session.sid })).status, 200);
    await w.drain();
    const events = w.env.DB.db.prepare('SELECT * FROM logout_outbox').all();
    assert.equal(events.length, 2); assert.ok(events.every(row => row.sid === w.signed.session.sid && row.user_id === w.user.id));
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM app_sessions').get().n, 2);
    assert.ok(w.env.DB.db.prepare('SELECT 1 FROM sessions WHERE sid=?').get(second.session.sid));
    assert.equal(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at, null);
    assert.equal(JSON.parse(w.env.DB.db.prepare("SELECT detail FROM audit WHERE event='admin_revoke_session'").get().detail).sid, w.signed.session.sid);
});

for (const kind of ['logout','revocation']) test(`${kind} uses current destination, parks without one, and retains captured URI`, async t => {
    const { w, row, table, deliver, message } = await pending(t, kind);
    const next = 'https://fixed.example/backchannel', admin = await adminLogin(w);
    const client = await (await admin.get('clients/app')).json();
    w.env.DB.db.prepare('UPDATE clients SET backchannel_uri=NULL WHERE id=?').run('app');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async uri => { calls++; assert.equal(uri, next); return new Response(null, { status: 204 }); });
    await assert.rejects(deliver(w.env, message), error => error.code === 'backchannel_config');
    assert.equal(calls, 0);
    const parked = w.env.DB.db.prepare(`SELECT * FROM ${table}`).get();
    assert.equal(parked.delivered_at, null); assert.equal(parked.delivery_state, 'missing_uri');
    const { deliveryStatus } = await import('../apps/server/src/services/outbox.mjs');
    assert.deepEqual((await deliveryStatus(w.env)).clients_missing_backchannel, ['app']);
    assert.equal((await admin.post('clients/app', { version: client.version, backchannel_uri: next, branding: { name: 'App' } })).status, 200);
    await deliver(w.env, message); assert.equal(calls, 1);
    const sent = w.env.DB.db.prepare(`SELECT * FROM ${table}`).get();
    assert.ok(sent.delivered_at); assert.equal(sent.uri, row.uri); assert.equal(sent.delivery_state, 'delivered');
});

for (const kind of ['logout','revocation']) test(`${kind} expires after 24 hours, audits once, and acknowledges without delivery`, async t => {
    const { w, row, table, message } = await pending(t, kind);
    w.env.DB.db.prepare(`UPDATE ${table} SET created=?,last_error=? WHERE id=?`)
        .run(Date.now() - deliveryWindowMs - 1, 'Previous delivery failed.', row.id);
    let posts = 0, acknowledgements = 0, retries = 0;
    t.mock.method(globalThis, 'fetch', async () => { posts++; throw new Error('Should not deliver'); });
    w.env.LOGOUT_QUEUE.send = async () => { throw new Error('Expired event was enqueued'); };
    await dispatchOutbox(w.env, table, message.body.type);
    message.ack = () => { acknowledgements++; }; message.retry = () => { retries++; };
    await queue({ messages: [message] }, w.env);
    await queue({ messages: [message] }, w.env);
    await dispatchOutbox(w.env, table, message.body.type);
    assert.equal(posts, 0); assert.equal(acknowledgements, 2); assert.equal(retries, 0);
    const expired = w.env.DB.db.prepare(`SELECT delivery_state,last_error FROM ${table} WHERE id=?`).get(row.id);
    assert.equal(expired.delivery_state, 'expired'); assert.equal(expired.last_error, 'Previous delivery failed.');
    const audits = w.env.DB.db.prepare("SELECT target,detail FROM audit WHERE event='backchannel_expired'").all();
    assert.equal(audits.length, 1); assert.equal(audits[0].target, 'app');
    assert.deepEqual(JSON.parse(audits[0].detail), { client_id: 'app', event_kind: message.body.type, event_id: row.id });
});

for (const kind of ['logout','revocation']) test(`${kind} younger event retries and client console/API report delivery state`, async t => {
    const { w, row, table, message } = await pending(t, kind);
    const admin = await adminLogin(w);
    w.env.DB.db.prepare(`UPDATE ${table} SET created=? WHERE id=?`).run(Date.now() - deliveryWindowMs + 60000, row.id);
    let posts = 0, retries = 0;
    t.mock.method(globalThis, 'fetch', async () => { posts++; return new Response(null, { status: 503 }); });
    const enqueued = [];
    w.env.LOGOUT_QUEUE.send = async event => { enqueued.push(event); };
    await dispatchOutbox(w.env, table, message.body.type);
    assert.deepEqual(enqueued, [message.body]);
    message.retry = () => { retries++; }; message.ack = () => { throw new Error('Unexpected ack'); };
    await queue({ messages: [message] }, w.env);
    assert.equal(posts, 1); assert.equal(retries, 1);
    const api = await (await admin.get('clients/app')).json();
    assert.equal(api.delivery.counts.undelivered, 1); assert.equal(api.delivery.counts.expired, 0);
    assert.equal(api.delivery.events[0].id, row.id);
    assert.match(api.delivery.events[0].last_error, /refused delivery \(HTTP 503\)\./);
    const html = await (await w.call('/admin/clients/app', { headers: { cookie: admin.cookie } })).text();
    assert.match(html, /<dt class="fd-kv-key">Undelivered<\/dt><dd class="fd-kv-value"><span class="fd-kv-text">1<\/span><\/dd>/); assert.match(html, /<dt class="fd-kv-key">Expired<\/dt><dd class="fd-kv-value"><span class="fd-kv-text">0<\/span><\/dd>/);
    w.env.DB.db.prepare(`UPDATE ${table} SET created=? WHERE id=?`).run(Date.now() - deliveryWindowMs - 1, row.id);
    await queue({ messages: [message] }, w.env);
    const expired = await (await admin.get('clients/app')).json();
    assert.equal(expired.delivery.counts.undelivered, 0); assert.equal(expired.delivery.counts.expired, 1);
    assert.equal(expired.delivery.events[0].delivery_state, 'expired');
    const expiredHtml = await (await w.call('/admin/clients/app', { headers: { cookie: admin.cookie } })).text();
    assert.match(expiredHtml, /<dt class="fd-kv-key">Expired<\/dt><dd class="fd-kv-value"><span class="fd-kv-text">1<\/span><\/dd>/); assert.match(expiredHtml, /Back-channel endpoint refused delivery/);
});
