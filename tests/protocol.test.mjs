import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, basic } from './support/world.mjs';
import { randomToken } from '../apps/server/src/lib/crypto.mjs';
import worker from '../apps/server/src/worker.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';

test('SSO and prompt none with session issue code without interactive sign-in', async t => {
    const w = await world(t), signed = await login(w, t);
    const response = await w.authorize({ prompt: 'none' }, signed.cookie);
    assert.equal(response.status, 303);
    assert.ok(new URL(response.headers.get('location')).searchParams.get('code'));
    assert.equal((await w.authorize({ prompt: 'login' }, signed.cookie)).status, 200);
});
for (const kind of ['blocked', 'deleted', 'expired session']) test(`${kind} refuses authorization and pending code exchange`, async t => {
    const w = await world(t), signed = await login(w, t);
    if (kind === 'expired session') w.env.DB.db.exec('UPDATE sessions SET expires_at=0');
    else w.env.DB.db.prepare('UPDATE users SET status=?').run(kind);
    const response = await w.authorize({ prompt: 'none' }, signed.cookie);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'login_required');
    assert.equal((await w.exchange(signed.code)).status, 400);
});
for (const kind of ['expired', 'unknown', 'id token', 'blocked user', 'expired session']) test(`userinfo refuses ${kind}`, async t => {
    const w = await world(t), signed = await login(w, t), tokens = await (await w.exchange(signed.code)).json();
    if (kind === 'expired') w.env.DB.db.exec('UPDATE access_tokens SET expires_at=0');
    if (kind === 'blocked user') w.env.DB.db.exec("UPDATE users SET status='blocked'");
    if (kind === 'expired session') w.env.DB.db.exec('UPDATE sessions SET expires_at=0');
    const bearer = kind === 'unknown' ? randomToken() : kind === 'id token' ? tokens.id_token : tokens.access_token;
    const response = await w.call('/userinfo', { headers: { authorization: 'Bearer ' + bearer } });
    assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /Bearer/);
});
test('parallel code exchange consumes the code once, and the replay leaves no live access token (S16)', async t => {
    const w = await world(t), signed = await login(w, t);
    const responses = await Promise.all([w.exchange(signed.code), w.exchange(signed.code)]);
    assert.ok(responses.some(r => r.status === 400));
    // Whichever request lost is a replay: it revokes what the code issued, including an issuance still in flight.
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM access_tokens').get().n, 0);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='code_replay'").get().n, 1);
});
test('a sequential code replay deletes the access token the first exchange issued (S16)', async t => {
    const w = await world(t), signed = await login(w, t);
    const first = await (await w.exchange(signed.code)).json();
    assert.equal((await w.call('/userinfo', { headers: { authorization: `Bearer ${first.access_token}` } })).status, 200);
    assert.equal((await w.exchange(signed.code)).status, 400);
    assert.equal((await w.call('/userinfo', { headers: { authorization: `Bearer ${first.access_token}` } })).status, 401);
});
test('development clients alone allow exact localhost HTTP redirects', async t => {
    const w = await world(t), uri = 'http://localhost:3000/callback';
    w.env.DB.db.prepare('UPDATE clients SET redirect_uris=?').run(JSON.stringify([uri]));
    assert.equal((await w.authorize({ redirect_uri: uri })).status, 400);
    w.env.DB.db.exec('UPDATE clients SET dev=1');
    assert.equal((await w.authorize({ redirect_uri: uri })).status, 200);
    const evil = 'http://localhost.evil.example/callback';
    w.env.DB.db.prepare('UPDATE clients SET redirect_uris=?').run(JSON.stringify([evil]));
    assert.equal((await w.authorize({ redirect_uri: evil })).status, 400);
});
for (const uri of ['javascript:alert(1)', 'http://app.example/callback', 'https://app.example/callback#fragment', 'https://user:password@app.example/callback'])
    test(`even stored client URI is refused: ${uri}`, async t => {
        const w = await world(t); w.env.DB.db.prepare('UPDATE clients SET redirect_uris=?').run(JSON.stringify([uri]));
        assert.equal((await w.authorize({ redirect_uri: uri })).status, 400);
    });
test('public client exchanges with PKCE, never invites or accepts a secret', async t => {
    const w = await world(t); w.env.DB.db.exec("UPDATE clients SET secret_hash=NULL WHERE id='app'");
    const signed = await login(w, t);
    const response = await w.call('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'app', code: signed.code, code_verifier: w.verifier, redirect_uri: 'https://app.example/callback' }) });
    assert.equal(response.status, 200);
    assert.equal((await w.post('/v1/invitations', { email: 'invite@example.com', client_id: 'app' })).status, 401);
});
for (const kind of ['wrong secret', 'wrong client', 'missing credentials', 'body secret', 'malformed email']) test(`invitations refuse ${kind}`, async t => {
    const w = await world(t);
    const headers = kind === 'missing credentials' || kind === 'body secret' ? {} : { authorization: kind === 'wrong secret' ? basic('app', 'wrong') : kind === 'wrong client' ? basic('missing') : basic() };
    const body = { email: kind === 'malformed email' ? 'bad\r\naddress' : 'invite@example.com', ...(kind === 'body secret' ? { client_id: 'app', client_secret: 'secret' } : {}) };
    assert.equal((await w.post('/v1/invitations', body, '', headers)).status, kind === 'malformed email' ? 400 : 401);
});
test('invitations upsert one normalized email for 30d; actor client cannot choose another client', async t => {
    const w = await world(t), now = Date.now();
    for (let n = 0; n < 2; n++) assert.equal((await w.post('/v1/invitations', { email: 'Invite@example.com' }, '', { authorization: basic() })).status, 201);
    const row = w.env.DB.db.prepare('SELECT * FROM invitations').get();
    assert.equal(row.email, 'invite@example.com'); assert.equal(row.client_id, 'app');
    assert.ok(row.expires_at >= now + 30 * 86400000);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM invitations').get().n, 1);
    assert.equal((await w.post('/v1/invitations', { email: 'a@example.com', client_id: 'other' }, '', { authorization: basic() })).status, 401);
});
test('audit append-only triggers reject update/delete', async t => {
    const w = await world(t); await login(w, t);
    assert.throws(() => w.env.DB.db.exec("UPDATE audit SET event='edited'"), /append-only/);
    assert.throws(() => w.env.DB.db.exec('DELETE FROM audit'), /append-only/);
});
test('scheduled cleanup removes expired auth state but retains audit; queue stub retries without claiming delivery', async t => {
    const w = await world(t); await login(w, t);
    w.env.DB.db.exec('UPDATE sessions SET expires_at=0');
    await worker.scheduled({}, w.env);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.ok(w.env.DB.db.prepare('SELECT count(*) AS n FROM audit').get().n > 0);
    let retried = 0;
    await worker.queue({ messages: [{ retry(value) { assert.equal(value.delaySeconds, 3600); retried++; }, ack() { assert.fail('Must not ACK unimplemented delivery'); } }] });
    assert.equal(retried, 1);
});
test('malformed input, duplicate parameters and oversized bodies fail explicitly', async t => {
    const w = await world(t);
    assert.equal((await w.call('/authorize?client_id=app&client_id=other')).status, 400);
    assert.equal((await w.call('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=a&code=b' })).status, 400);
    assert.equal((await w.post('/v1/invitations', { email: 'x'.repeat(17000) }, '', { authorization: basic() })).status, 413);
    assert.equal((await w.call('/v1/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'invalid' })).status, 400);
    assert.equal((await w.call('/token', { method: 'POST', body: 'untyped' })).status, 415);
});
test('wrong issuer host, unknown route, and missing authentication refuse', async t => {
    const w = await world(t);
    const unknown = await worker.fetch(new Request('https://evil.example/login'), w.env, {});
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown_realm');
    assert.equal((await w.call('/unknown')).status, 404);
    assert.equal((await w.call('/signed-in')).status, 401);
    assert.equal((await w.call('/userinfo')).status, 401);
});
test('session issuance rejects a blocked/merged user even with a stale active object', async t => {
    const w = await world(t);
    w.env.DB.db.exec("INSERT INTO users(id,email,status,created) VALUES('u','u@example.com','blocked',0)");
    await assert.rejects(issueSession(w.env, { id: 'u', status: 'active' }, 'email'), { code: 'access_denied' });
});

test('UserInfo also supports POST with bearer header per OIDC Core', async t => {
    const w = await world(t), signed = await login(w, t), tokens = await (await w.exchange(signed.code)).json();
    assert.equal((await w.call('/userinfo', { method: 'POST', headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 200);
});
