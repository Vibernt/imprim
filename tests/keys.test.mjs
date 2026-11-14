// Rotation and concurrency scenarios ported from Assay tests/workload-identity.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { signingKey, jwksDocument, cachedJwks, revokeKeyNow, keySweep, ROTATION_MS, PUBLISH_AHEAD_MS, RETIRED_KEEP_MS } from '../apps/server/src/oidc/keys.mjs';
test('concurrent first use converges on one sealed ES256 generation', async t => {
    const { env } = await world(t), now = Date.now();
    const results = await Promise.all([...Array.from({ length: 6 }, () => signingKey(env, now)), ...Array.from({ length: 6 }, () => jwksDocument(env, now))]);
    const row = env.DB.db.prepare('SELECT * FROM signing_keys').get();
    assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM signing_keys').get().n, 1);
    for (const value of results) assert.equal(value.kid || value.keys[0].kid, row.kid);
    assert.ok(!row.sealed_jwk.includes('"d":'));
    assert.equal(results[0].key.extractable, false);
});
test('rotation publishes 1h before signing at 90d and retires old key 24h later', async t => {
    const { env } = await world(t), now = Date.now();
    assert.deepEqual(await keySweep(env, now), { rotated: false, deleted: 0 });
    const first = (await signingKey(env, now)).kid;
    const publish = now + ROTATION_MS - PUBLISH_AHEAD_MS, activation = now + ROTATION_MS;
    assert.equal((await keySweep(env, publish - 1)).rotated, false);
    assert.equal((await keySweep(env, publish)).rotated, true);
    assert.equal((await keySweep(env, publish + 1)).rotated, false);
    const published = await jwksDocument(env, publish);
    assert.equal(published.keys.length, 2);
    const second = published.keys.find(k => k.kid !== first).kid;
    assert.equal((await signingKey(env, activation - 1)).kid, first);
    assert.equal((await signingKey(env, activation)).kid, second);
    assert.equal((await keySweep(env, activation + RETIRED_KEEP_MS - 1)).deleted, 0);
    assert.equal((await keySweep(env, activation + RETIRED_KEEP_MS)).deleted, 1);
    assert.deepEqual((await jwksDocument(env, activation + RETIRED_KEEP_MS)).keys.map(k => k.kid), [second]);
});
test('unreadable key is retired, audited and replaced without a broken JWKS entry', async t => {
    const { env } = await world(t); const old = await signingKey(env);
    env.SEALING_KEY = 'cd'.repeat(32);
    const next = await signingKey(env);
    assert.notEqual(next.kid, old.kid);
    assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM signing_keys').get().n, 2);
    assert.ok(env.DB.db.prepare('SELECT retired_at FROM signing_keys WHERE kid=?').get(old.kid).retired_at);
    // Unreadable is not compromised: the old public key keeps verifying tokens it signed for the overlap window.
    assert.deepEqual((await jwksDocument(env)).keys.map(k => k.kid), [old.kid, next.kid]);
    assert.deepEqual((await jwksDocument(env, Date.now() + RETIRED_KEEP_MS + 1000)).keys.map(k => k.kid), [next.kid]);
    assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='oidc_key_unreadable'").get().n, 1);
});
test('a transient database error never retires a healthy signing key (S6)', async t => {
    const { env } = await world(t); const key = await signingKey(env);
    const prepare = env.DB.prepare;
    env.DB.prepare = sql => sql.startsWith('SELECT sealed_jwk') ? { bind: () => ({ first: async () => { throw new Error('D1_ERROR: network connection lost'); } }) } : prepare(sql);
    await assert.rejects(signingKey(env), /network connection lost/);
    await assert.rejects(jwksDocument(env), /network connection lost/);
    env.DB.prepare = sql => sql.startsWith('SELECT sealed_jwk') ? { bind: () => ({ first: async () => null }) } : prepare(sql);
    await assert.rejects(signingKey(env), error => error.code === 'key_unavailable');
    env.DB.prepare = prepare;
    assert.equal(env.DB.db.prepare('SELECT retired_at FROM signing_keys WHERE kid=?').get(key.kid).retired_at, null);
    assert.equal((await signingKey(env)).kid, key.kid);
    assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='oidc_key_unreadable'").get().n, 0);
});
test('emergency revocation drops a key from JWKS at once and signs with a replacement (S15)', async t => {
    const { env } = await world(t); const old = await signingKey(env);
    assert.deepEqual((await cachedJwks(env)).keys.map(k => k.kid), [old.kid]);
    const result = await revokeKeyNow(env, 'admin', old.kid);
    assert.equal(result.removed_from_jwks, true);
    const next = await signingKey(env);
    assert.notEqual(next.kid, old.kid);
    assert.deepEqual((await cachedJwks(env)).keys.map(k => k.kid), [next.kid]);
    await assert.rejects(revokeKeyNow(env, 'admin', old.kid), error => error.code === 'invalid_request');
    await assert.rejects(revokeKeyNow(env, 'admin', 'missing'), error => error.code === 'not_found');
    assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='admin_key_revoke'").get().n, 1);
});
test('sealed signing key cannot be copied to another kid (AAD binding)', async t => {
    const { env } = await world(t); await signingKey(env);
    env.DB.db.exec("UPDATE signing_keys SET kid='swapped'");
    const next = await signingKey(env);
    assert.notEqual(next.kid, 'swapped');
    // The swapped row never signs again; its public half stays only for the overlap window.
    assert.deepEqual((await jwksDocument(env)).keys.map(k => k.kid), ['swapped', next.kid]);
    assert.equal((await signingKey(env)).kid, next.kid);
});
test('unreadable prepublished key is retired before JWKS is returned', async t => {
    const { env } = await world(t), now = Date.now();
    const first = (await signingKey(env, now)).kid;
    await keySweep(env, now + ROTATION_MS - PUBLISH_AHEAD_MS);
    const future = env.DB.db.prepare('SELECT kid FROM signing_keys WHERE kid<>?').get(first).kid;
    env.DB.db.prepare('UPDATE signing_keys SET sealed_jwk=? WHERE kid=?').run('broken', future);
    const keys = (await jwksDocument(env, now)).keys.map(key => key.kid);
    assert.ok(keys.includes(first));
    assert.ok(!keys.includes(future));
    assert.equal(keys.length, 2);
    assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='oidc_key_unreadable'").get().n, 1);
});
test('JWKS and discovery advertise only ES256, never symmetric or none', async t => {
    const w = await world(t);
    const doc = await (await w.call('/.well-known/openid-configuration')).json();
    assert.deepEqual(doc.id_token_signing_alg_values_supported, ['ES256']);
    assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
    for (const key of (await (await w.call('/.well-known/jwks.json')).json()).keys) {
        assert.deepEqual(Object.keys(key).sort(), ['alg','crv','kid','kty','use','x','y']);
        assert.equal(key.kty, 'EC'); assert.equal(key.crv, 'P-256'); assert.equal(key.alg, 'ES256');
    }
});
