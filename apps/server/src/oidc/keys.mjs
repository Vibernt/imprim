// Signing keys per realm and algorithm, sealed at rest. Generation races converge via INSERT OR IGNORE.
// Each realm has two rings: ES256, which signs everything by default, and RS256, which signs ID tokens (and the
// logout tokens) of apps that choose it. Both rotate on the same schedule and are published in one JWKS.
import { seal, unseal } from '../lib/crypto.mjs';
import { invariant, AppError } from '../lib/errors.mjs';
import { audit } from '../services/audit.mjs';
import { realmId, memoKey } from '../realms/realm.mjs';
// Every query names the realm: each realm has its own ring, generations and JWKS.
export const ROTATION_MS = 90 * 86400000, PUBLISH_AHEAD_MS = 3600000, RETIRED_KEEP_MS = 86400000;
// The algorithms, their Web Crypto parameters and the public members each JWK publishes.
export const ALGORITHMS = Object.freeze({
    ES256: { generate: { name: 'ECDSA', namedCurve: 'P-256' }, key: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' },
        publicJwk: ({ kty, crv, x, y }) => ({ kty, crv, x, y }) },
    RS256: { generate: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' }, publicJwk: ({ kty, n, e }) => ({ kty, n, e }) }
});
const ALGS = Object.keys(ALGORITHMS);
const spec = alg => { invariant(Object.hasOwn(ALGORITHMS, alg), 'key_unavailable', 'Unsupported signing algorithm.', 500); return ALGORITHMS[alg]; };
const publicJwk = (alg, jwk) => spec(alg).publicJwk(jwk);
const rows = async (env, alg) => (await env.DB.prepare('SELECT alg,generation,kid,public_jwk,activates_at,retired_at,verification_until FROM signing_keys WHERE realm_id=? AND alg=? ORDER BY generation')
    .bind(realmId(env), alg).all()).results;
async function createKey(env, alg, generation, now, activates, actor = null) {
    const pair = await crypto.subtle.generateKey(spec(alg).generate, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey), kid = crypto.randomUUID();
    const sealed = await seal(env, JSON.stringify(jwk), `oidc-signing-key:${kid}`);
    const insert = env.DB.prepare(`INSERT OR IGNORE INTO signing_keys(realm_id,alg,generation,kid,public_jwk,sealed_jwk,created_at,activates_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(realmId(env), alg, generation, kid, JSON.stringify(publicJwk(alg, jwk)), sealed, now, activates);
    const result = await env.DB.batch([insert, ...(actor ? [env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
        SELECT 'admin_key_rotate',?,?,?,?,? WHERE changes()=1`).bind(actor, kid, JSON.stringify({ alg, generation, activates_at: activates }), now, realmId(env))] : [])]);
    forgetJwks(env);
    return result[0].meta.changes === 1 ? { kid, generation, activates_at: activates } : null;
}
// Only proven corruption retires a key: an AES-GCM authentication failure, an unreadable envelope, or a public-key
// mismatch. A D1 error or a row deleted mid-read is rethrown, so a transient fault never retires a healthy key (S6).
const corrupt = message => Object.assign(new AppError(503, 'key_corrupt', message), { corrupt: true });
async function openKey(env, row) {
    const stored = await env.DB.prepare('SELECT sealed_jwk FROM signing_keys WHERE realm_id=? AND alg=? AND generation=?').bind(realmId(env), row.alg, row.generation).first();
    invariant(typeof stored?.sealed_jwk === 'string', 'key_unavailable', 'Signing key row is unavailable.', 503);
    let envelope;
    try { envelope = JSON.parse(stored.sealed_jwk); } catch { throw corrupt('Signing key envelope is not JSON.'); }
    if (envelope?.version !== 1 || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv) || !/^[A-Za-z0-9_-]{20,}$/.test(envelope.ciphertext ?? '')) throw corrupt('Signing key envelope is malformed.');
    let plain;
    try { plain = await unseal(env, stored.sealed_jwk, `oidc-signing-key:${row.kid}`); }
    catch (error) {
        if (error?.code === 'key_config') throw error;
        if (error?.name === 'OperationError' || error instanceof SyntaxError || error?.code === 'key_unavailable') throw corrupt('Signing key cannot be unsealed.');
        throw error;
    }
    let jwk;
    try { jwk = JSON.parse(plain); } catch { throw corrupt('Signing key plaintext is not a JWK.'); }
    if (JSON.stringify(publicJwk(row.alg, jwk)) !== row.public_jwk) throw corrupt('Signing key public data does not match.');
    return jwk;
}
async function retireKey(env, row, now) {
    // An unreadable key is not a compromised one: tokens it already signed stay verifiable for the overlap window.
    // A key that was only published, never active, signed nothing and leaves JWKS at once.
    const retired = await env.DB.prepare('UPDATE signing_keys SET retired_at=?,verification_until=? WHERE realm_id=? AND alg=? AND generation=? AND retired_at IS NULL')
        .bind(now, row.activates_at > now ? now : now + RETIRED_KEEP_MS, realmId(env), row.alg, row.generation).run();
    forgetJwks(env);
    if (retired.meta.changes) {
        await audit(env, 'oidc_key_unreadable', null, { kid: row.kid, alg: row.alg, generation: row.generation });
        console.error(JSON.stringify({ type: 'oidc_key_unreadable', kid: row.kid, alg: row.alg, generation: row.generation }));
    }
    const latest = (await rows(env, row.alg)).at(-1);
    await createKey(env, row.alg, latest.generation + 1, now, row.activates_at > now ? row.activates_at : now);
}
async function publishedKeys(env, alg, now = Date.now()) {
    let keys = await rows(env, alg);
    if (!keys.length) { await createKey(env, alg, 1, now, now); keys = await rows(env, alg); }
    invariant(keys.length, 'key_unavailable', 'No signing key is available.', 503);
    return keys;
}
// Discovery and JWKS carry no per-address limit (S2), so the document is memoised per isolate for a minute.
// Rotation publishes an hour ahead; an emergency revocation clears this isolate's copy at once.
const jwksMemo = new WeakMap();
const memoFor = env => { let realms = jwksMemo.get(memoKey(env)); if (!realms) jwksMemo.set(memoKey(env), realms = new Map()); return realms; };
export const forgetJwks = env => memoFor(env).delete(realmId(env));
export async function cachedJwks(env, now = Date.now()) {
    const hit = memoFor(env).get(realmId(env));
    if (hit && hit.until > now) return hit.document;
    const document = await jwksDocument(env, now);
    memoFor(env).set(realmId(env), { document, until: now + 60000 });
    return document;
}
// Both rings, so an app that chooses RS256 finds its key already published.
export async function jwksDocument(env, now = Date.now()) {
    const keys = [];
    for (const alg of ALGS) {
        await signingKey(env, now, alg);
        for (const row of (await rows(env, alg)).filter(row => row.retired_at === null)) {
            try { await openKey(env, row); }
            catch (error) {
                if (!error?.corrupt) throw error;
                await retireKey(env, row, now);
            }
        }
        keys.push(...(await publishedKeys(env, alg, now)).filter(row => row.retired_at === null || row.verification_until > now)
            .map(row => ({ ...publicJwk(alg, JSON.parse(row.public_jwk)), kid: row.kid, use: 'sig', alg })));
    }
    return { keys };
}
// The active key of one ring, ready to sign: { kid, key, alg, params } where params is the Web Crypto sign algorithm.
export async function signingKey(env, now = Date.now(), alg = 'ES256') {
    const { key: keyAlgorithm, sign } = spec(alg);
    for (let attempt = 0; attempt < 2; attempt++) {
        const keys = await publishedKeys(env, alg, now);
        const active = keys.filter(row => row.activates_at <= now && row.retired_at === null).at(-1);
        if (!active) {
            await createKey(env, alg, keys.at(-1).generation + 1, now, now);
            continue;
        }
        try {
            const jwk = await openKey(env, active);
            const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'], ext: false }, keyAlgorithm, false, ['sign']);
            return { kid: active.kid, key, alg, params: sign };
        } catch (error) {
            if (!error?.corrupt) throw error;
        }
        await retireKey(env, active, now);
    }
    invariant(false, 'key_unavailable', 'No readable signing key is available.', 503);
}
export async function keySweep(env, now = Date.now()) {
    let rotated = false, deleted = 0;
    for (const alg of ALGS) {
        const result = await sweepRing(env, alg, now);
        rotated ||= result.rotated; deleted += result.deleted;
    }
    return { rotated, deleted };
}
async function sweepRing(env, alg, now) {
    const keys = await rows(env, alg);
    if (!keys.length) return { rotated: false, deleted: 0 };
    const newest = keys.filter(row => row.retired_at === null).at(-1);
    if (!newest) return { rotated: false, deleted: 0 };
    // Publish one hour before the 90-day activation boundary; delayed sweeps still wait a full hour.
    const rotated = now >= newest.activates_at + ROTATION_MS - PUBLISH_AHEAD_MS;
    if (rotated) await createKey(env, alg, newest.generation + 1, now, now + PUBLISH_AHEAD_MS);
    const realm = realmId(env);
    await env.DB.prepare(`UPDATE signing_keys SET retired_at=(SELECT MAX(activates_at) FROM signing_keys WHERE realm_id=?1 AND alg=?4 AND activates_at<=?2 AND retired_at IS NULL),
        verification_until=(SELECT MAX(activates_at) FROM signing_keys WHERE realm_id=?1 AND alg=?4 AND activates_at<=?2 AND retired_at IS NULL)+?3
        WHERE realm_id=?1 AND alg=?4 AND retired_at IS NULL AND generation<(SELECT MAX(generation) FROM signing_keys WHERE realm_id=?1 AND alg=?4 AND activates_at<=?2 AND retired_at IS NULL)`)
        .bind(realm, now, RETIRED_KEEP_MS, alg).run();
    const result = await env.DB.prepare('DELETE FROM signing_keys WHERE realm_id=?1 AND alg=?3 AND generation < (SELECT MAX(generation) FROM signing_keys WHERE realm_id=?1 AND alg=?3 AND activates_at<=?2 AND retired_at IS NULL)')
        .bind(realm, now - RETIRED_KEEP_MS, alg).run();
    return { rotated, deleted: result.meta.changes };
}

// Manual rotation follows the same publication window as scheduled rotation, and rotates both rings. The ES256 key
// is the response, as before; the RS256 ring rotates alongside unless it already has a key waiting.
export async function rotateNow(env, actor, now = Date.now()) {
    const keys = await publishedKeys(env, 'ES256', now);
    invariant(!keys.some(row => row.retired_at === null && row.activates_at > now),
        'rotation_pending', 'A published key is already awaiting activation.', 409);
    const created = await createKey(env, 'ES256', keys.at(-1).generation + 1, now, now + PUBLISH_AHEAD_MS, actor);
    invariant(created, 'rotation_pending', 'Another rotation won; reload the key list.', 409);
    const rsa = await publishedKeys(env, 'RS256', now);
    if (!rsa.some(row => row.retired_at === null && row.activates_at > now)) await createKey(env, 'RS256', rsa.at(-1).generation + 1, now, now + PUBLISH_AHEAD_MS, actor);
    return created;
}
export async function keyList(env, now = Date.now()) {
    const list = [];
    for (const alg of ALGS) {
        const keys = await publishedKeys(env, alg, now);
        const active = keys.filter(row => row.retired_at === null && row.activates_at <= now).at(-1);
        list.push(...keys.map(({ public_jwk, ...row }) => ({ ...row,
            status: row.retired_at !== null || row.generation < active?.generation ? 'retired' : row.activates_at > now ? 'published' : 'active' })));
    }
    return list;
}

// Emergency revocation (S15): the key leaves JWKS at once and a replacement signs immediately. Unlike a scheduled
// rotation there is no overlap, so tokens signed by the revoked key stop verifying as soon as relying parties refetch.
export async function revokeKeyNow(env, actor, kid, now = Date.now()) {
    invariant(typeof kid === 'string' && kid.length > 0 && kid.length <= 100, 'invalid_request', 'Key id required.');
    let keys = [], row;
    for (const alg of ALGS) { const ring = await publishedKeys(env, alg, now); if (ring.some(key => key.kid === kid)) { keys = ring; row = ring.find(key => key.kid === kid); } }
    invariant(row, 'not_found', 'Signing key not found.', 404);
    invariant(row.retired_at === null || row.verification_until > now, 'invalid_request', 'Key is already out of JWKS.');
    const result = await env.DB.batch([
        env.DB.prepare('UPDATE signing_keys SET retired_at=coalesce(retired_at,?),verification_until=? WHERE realm_id=? AND alg=? AND generation=?').bind(now, now, realmId(env), row.alg, row.generation),
        env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES('admin_key_revoke',?,?,?,?,?)`)
            .bind(actor, kid, JSON.stringify({ alg: row.alg, generation: row.generation }), now, realmId(env))
    ]);
    invariant(result[0].meta.changes === 1, 'conflict', 'Key changed; reload.', 409);
    if (!keys.some(key => key.kid !== kid && key.retired_at === null && key.activates_at <= now))
        await createKey(env, row.alg, keys.at(-1).generation + 1, now, now, actor);
    forgetJwks(env);
    return { kid, revoked: true, removed_from_jwks: true };
}
