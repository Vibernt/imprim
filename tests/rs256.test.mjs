// RS256 ID tokens: the second signing ring, the per-app choice, logout tokens that follow it, and hints that are
// verified by their key's own algorithm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, basic } from './support/world.mjs';
import { signingKey, jwksDocument, keySweep, ROTATION_MS, PUBLISH_AHEAD_MS } from '../apps/server/src/oidc/keys.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';

const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url'));
const rs256 = (w, id = 'app') => w.env.DB.db.prepare("UPDATE clients SET id_token_signed_response_alg='RS256' WHERE id=?").run(id);
async function verifies(w, jwt) {
    const header = part(jwt, 0), jwk = (await (await w.call('/.well-known/jwks.json')).json()).keys.find(key => key.kid === header.kid);
    assert.ok(jwk, 'the signing key is published');
    assert.equal(jwk.alg, header.alg);
    const params = header.alg === 'RS256' ? [{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, { name: 'RSASSA-PKCS1-v1_5' }] : [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }];
    const key = await crypto.subtle.importKey('jwk', jwk, params[0], false, ['verify']);
    const [h, b, s] = jwt.split('.');
    return crypto.subtle.verify(params[1], key, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${b}`));
}
const forge = (header, claims) => `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${Buffer.alloc(256).toString('base64url')}`;

test('an app that chooses RS256 gets RS256 ID tokens that verify against JWKS', async t => {
    const w = await world(t);
    rs256(w);
    const signed = await login(w, t);
    const { id_token } = await (await w.exchange(signed.code)).json();
    assert.equal(part(id_token, 0).alg, 'RS256');
    assert.equal(part(id_token, 0).typ, 'JWT');
    assert.equal(part(id_token, 1).aud, 'app');
    assert.equal(await verifies(w, id_token), true);
});
test('apps keep ES256 unless they choose otherwise', async t => {
    const w = await world(t), signed = await login(w, t);
    const { id_token } = await (await w.exchange(signed.code)).json();
    assert.equal(part(id_token, 0).alg, 'ES256');
    assert.equal(await verifies(w, id_token), true);
});
test('a logout token uses the same algorithm as the app’s ID tokens', async t => {
    const { deliverLogout } = await import('../apps/server/src/oidc/backchannel.mjs');
    const w = await world(t);
    rs256(w);
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel'");
    const sent = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(new URLSearchParams(init.body).get('logout_token')); return new Response(null, { status: 200 }); });
    for (const [id, client] of [['e1', 'app'], ['e2', 'other']]) {
        w.env.DB.db.prepare("INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created) VALUES(?,?,'u','s','x',?)").run(id, client, Date.now());
        await deliverLogout(w.env, { body: { event_id: id } });
    }
    assert.deepEqual(sent.map(jwt => part(jwt, 0).alg), ['RS256', 'ES256']);
    assert.deepEqual(sent.map(jwt => part(jwt, 0).typ), ['logout+jwt', 'logout+jwt']);
    for (const jwt of sent) assert.equal(await verifies(w, jwt), true);
});
test('an RS256 ID token works as id_token_hint', async t => {
    const w = await world(t);
    rs256(w);
    const first = await login(w, t);
    const { id_token } = await (await w.exchange(first.code)).json();
    const response = await w.authorize({ prompt: 'none', id_token_hint: id_token }, first.cookie);
    assert.ok(new URL(response.headers.get('location')).searchParams.get('code'));
});
test('a hint whose header names another algorithm than its key is refused, as are none and HMAC', async t => {
    const w = await world(t), first = await login(w, t);
    const { id_token } = await (await w.exchange(first.code)).json();
    const claims = part(id_token, 1), keys = (await jwksDocument(w.env)).keys;
    const ec = keys.find(key => key.alg === 'ES256').kid, rsa = keys.find(key => key.alg === 'RS256').kid;
    const hints = [
        forge({ alg: 'RS256', typ: 'JWT', kid: ec }, claims),
        forge({ alg: 'ES256', typ: 'JWT', kid: rsa }, claims),
        forge({ alg: 'HS256', typ: 'JWT', kid: ec }, claims),
        forge({ alg: 'none', typ: 'JWT', kid: ec }, claims),
        forge({ alg: 'PS256', typ: 'JWT', kid: rsa }, claims),
        // A genuine RS256 signature over different claims.
        `${id_token.split('.').slice(0, 2).join('.')}.${Buffer.alloc(256, 1).toString('base64url')}`
    ];
    for (const hint of hints) {
        const response = await w.authorize({ prompt: 'none', id_token_hint: hint }, first.cookie);
        assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'invalid_request', hint.slice(0, 40));
    }
});
test('the RS256 ring rotates on the same schedule, and an unreadable RS256 key is retired and replaced', async t => {
    const { env } = await world(t), now = Date.now();
    const first = (await signingKey(env, now, 'RS256')).kid;
    assert.equal((await keySweep(env, now + ROTATION_MS - PUBLISH_AHEAD_MS)).rotated, true);
    assert.equal((await signingKey(env, now + ROTATION_MS - 1, 'RS256')).kid, first);
    const second = (await signingKey(env, now + ROTATION_MS, 'RS256')).kid;
    assert.notEqual(second, first);
    env.SEALING_KEY = 'cd'.repeat(32);
    const third = await signingKey(env, now + ROTATION_MS, 'RS256');
    assert.notEqual(third.kid, second);
    assert.ok(env.DB.db.prepare('SELECT retired_at FROM signing_keys WHERE kid=?').get(second).retired_at);
    assert.equal(env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='oidc_key_unreadable'").get().n, 1);
    assert.equal(third.key.extractable, false);
    assert.ok(!env.DB.db.prepare('SELECT sealed_jwk FROM signing_keys WHERE kid=?').get(third.kid).sealed_jwk.includes('"d":'));
});
test('an unknown signing algorithm is refused by the key ring, the console and the seed script', async t => {
    const w = await world(t);
    await assert.rejects(signingKey(w.env, Date.now(), 'HS256'), error => error.code === 'key_unavailable');
    const config = { id: 'legacy', secret_hash: 'a'.repeat(64), redirect_uris: ['https://legacy.example/cb'], sign_in_methods: ['email'] };
    assert.match(clientSeedSql({ ...config, id_token_signed_response_alg: 'RS256' }), /'RS256'/);
    assert.throws(() => clientSeedSql({ ...config, id_token_signed_response_alg: 'PS256' }), /id_token_signed_response_alg/);
    const { saveClient } = await import('../apps/server/src/admin/clients.mjs');
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    await assert.rejects(saveClient(w.env, 'admin@example.com', 'app', { id_token_signed_response_alg: 'none', version: 0 }), /id_token_signed_response_alg/);
    const saved = await saveClient(w.env, 'admin@example.com', 'app', { id_token_signed_response_alg: 'RS256', version: 0 });
    assert.equal(saved.client.id_token_signed_response_alg, 'RS256');
    assert.throws(() => w.env.DB.db.exec("UPDATE clients SET id_token_signed_response_alg='HS256' WHERE id='app'"), /CHECK/);
});
test('imprim-client keeps verifying ES256 with RSA keys in JWKS, and refuses RS256 tokens it does not support', async t => {
    const w = await world(t), client = createClient({ issuer: w.env.ISSUER, clientId: 'app', redirectUri: 'https://app.example/callback', fetch: url => w.call(new URL(url).pathname) });
    const es = await login(w, t);
    const esToken = (await (await w.exchange(es.code)).json()).id_token;
    assert.equal((await client.verifyIdToken(esToken, { nonce: 'rp-nonce' })).aud, 'app');
    rs256(w);
    const rs = await login(w, t, 'second@example.com');
    const rsToken = (await (await w.exchange(rs.code)).json()).id_token;
    await assert.rejects(client.verifyIdToken(rsToken, { nonce: 'rp-nonce' }), error => error.code === 'invalid_token');
});
