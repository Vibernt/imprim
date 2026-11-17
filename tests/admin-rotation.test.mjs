import test from 'node:test';
import assert from 'node:assert/strict';
import { world, turnstile } from './support/world.mjs';
import { adminLogin } from './support/admin.mjs';
import { jwksDocument, keySweep, PUBLISH_AHEAD_MS, RETIRED_KEEP_MS } from '../apps/server/src/oidc/keys.mjs';
import { signAgentJwt } from '../apps/server/src/agents/grants.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';
const header = jwt => JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url'));
async function signature(jwt, jwks) {
    const [h,p,s] = jwt.split('.'), jwk = jwks.keys.find(k => k.kid === header(jwt).kid);
    assert.ok(jwk, 'kid is published');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + p)), true);
}
test('rotate publishes before signing; before/after JWKS verify overlap, unknown kid refresh succeeds, retirement waits', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const beforeRotation = await jwksDocument(w.env), es = doc => doc.keys.filter(k => k.alg === 'ES256'), oldKid = es(beforeRotation)[0].kid;
    const rotated = await a.post('keys/rotate'); assert.equal(rotated.status, 200, await rotated.clone().text());
    const next = await rotated.json(); assert.equal(next.activates_at, now + PUBLISH_AHEAD_MS);
    const beforeActivation = await jwksDocument(w.env); assert.equal(es(beforeActivation).length, 2);
    // The RS256 ring rotates alongside, published on the same schedule.
    assert.equal(beforeActivation.keys.filter(k => k.alg === 'RS256').length, 2);
    assert.ok(beforeActivation.keys.some(k => k.kid === next.kid));
    assert.equal((await a.post('keys/rotate')).status, 409);
    let fetched = 0;
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', redirectUri: 'https://app.example/callback', fetch: url => {
        if (new URL(url).pathname.endsWith('jwks.json')) { fetched++; return fetched === 1 ? Response.json(beforeRotation) : w.call('/.well-known/jwks.json'); }
        return w.call(new URL(url).pathname);
    } });
    const claims = () => ({ iss: w.env.ISSUER, aud: 'app', azp: 'app', sub: 'person', nonce: 'nonce', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600 });
    now = next.activates_at - 1000;
    const oldToken = await signAgentJwt(w.env, claims(), 'JWT'); assert.equal(header(oldToken).kid, oldKid);
    await signature(oldToken, beforeRotation); await signature(oldToken, beforeActivation);
    await client.verifyIdToken(oldToken, { nonce: 'nonce' }); assert.equal(fetched, 1);
    now = next.activates_at;
    const newToken = await signAgentJwt(w.env, claims(), 'JWT'); assert.equal(header(newToken).kid, next.kid);
    await keySweep(w.env, now);
    const afterActivation = await jwksDocument(w.env);
    for (const keys of [beforeActivation, afterActivation]) for (const token of [oldToken,newToken]) await signature(token, keys);
    await client.verifyIdToken(newToken, { nonce: 'nonce' }); assert.equal(fetched, 2);
    await client.verifyIdToken(oldToken, { nonce: 'nonce' });
    const row = w.env.DB.db.prepare('SELECT * FROM signing_keys WHERE kid=?').get(oldKid);
    assert.equal(row.retired_at, now); assert.equal(row.verification_until, now + RETIRED_KEEP_MS);
    now += 600000; await keySweep(w.env, now); assert.ok((await jwksDocument(w.env)).keys.some(k => k.kid === oldKid));
    now = next.activates_at + RETIRED_KEEP_MS;
    await keySweep(w.env, now); assert.ok(!(await jwksDocument(w.env)).keys.some(k => k.kid === oldKid));
    const audits = w.env.DB.db.prepare("SELECT * FROM audit WHERE event='admin_key_rotate' ORDER BY id").all();
    assert.deepEqual(audits.map(row => JSON.parse(row.detail).alg), ['ES256', 'RS256']);
    assert.equal(audits[0].target, next.kid); assert.ok(audits.every(row => row.actor));
});

test('concurrent Rotate now has one winner and one audit row', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w); await jwksDocument(w.env);
    const responses = await Promise.all([a.post('keys/rotate'), a.post('keys/rotate')]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200,409]);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM signing_keys WHERE alg='ES256'").get().n, 2);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM signing_keys WHERE alg='RS256'").get().n, 2);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_key_rotate'").get().n, 2);
});

test('logout verifier refuses invalid event bodies, missing subject/sid, nonce, types and cross-protocol tokens', async t => {
    const w = await world(t), now = Math.floor(Date.now()/1000), client = createClient({ issuer: w.env.ISSUER, clientId: 'app', redirectUri: 'https://app.example/callback', fetch: url => w.call(new URL(url).pathname) });
    const claims = { iss: w.env.ISSUER, aud: 'app', sub: 'person', sid: 'sid', jti: 'event', iat: now, exp: now+300, events: { 'http://schemas.openid.net/event/backchannel-logout': {} } };
    for (const patch of [{ sid: 123 }, { sid: '', sub: undefined }, { sub: undefined, sid: undefined }, { nonce: 'forbidden' }, { events: { 'http://schemas.openid.net/event/backchannel-logout': [] } },
        { events: { 'http://schemas.openid.net/event/backchannel-logout': { extra: true } } }, { events: { 'https://id.vibernt.ai/events/agent-revoked': {} } }, { aud: 'other' }, { iss: 'https://evil.example' }]) {
        const token = await signAgentJwt(w.env, { ...claims, ...patch }, 'logout+jwt');
        await assert.rejects(client.handleBackchannelLogout(new Request('https://app.example/logout', { method: 'POST', body: new URLSearchParams({ logout_token: token }) })), error => error.code === 'invalid_token');
    }
});

test('agent revocation verifier enforces audience, event, time, type and resource boundaries', async t => {
    const w = await world(t), now = Math.floor(Date.now()/1000), client = createClient({ issuer: w.env.ISSUER, clientId: 'app', redirectUri: 'https://app.example/callback', fetch: url => w.call(new URL(url).pathname) });
    const claims = { iss: w.env.ISSUER, aud: 'app', sub: 'person', grant_id: 'grant', resource: 'https://app.example/w/team/mcp', jti: 'event', iat: now, exp: now+300, events: { 'https://id.vibernt.ai/events/agent-revoked': {} } };
    const request = async (patch = {}, typ = 'secevent+jwt') => new Request('https://app.example/logout', { method: 'POST', body: new URLSearchParams({ revocation_token: await signAgentJwt(w.env, { ...claims, ...patch }, typ) }) });
    assert.deepEqual(await client.handleAgentRevocation(await request()), { sub: 'person', grant_id: 'grant', resource: claims.resource, jti: 'event' });
    for (const patch of [{ aud: 'wrong' }, { iss: 'https://evil.example' }, { grant_id: '' }, { sub: '' }, { jti: '' }, { resource: 'http://app.example/mcp' }, { exp: now }, { exp: now+901 }, { nonce: 'bad' },
        { events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }, { events: { 'https://id.vibernt.ai/events/agent-revoked': [] } }])
        await assert.rejects(client.handleAgentRevocation(await request(patch)));
    await assert.rejects(client.handleAgentRevocation(await request({}, 'at+jwt')));
    await assert.rejects(client.handleAgentRevocation(await request({}, 'JWT')), 'an ID-token type is not a security event (RFC 8417)');
});
