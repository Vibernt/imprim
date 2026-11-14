// DPoP proofs (RFC 9449): a JWT signed by the client's key, bound to the method and URL, fresh and single-use.
import { invariant } from '../lib/errors.mjs';
import { b64url, from64, sha256 } from '../lib/crypto.mjs';
export const DPOP_ALGS = ['ES256', 'RS256', 'EdDSA'];
const ALG = { ES256: [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }], RS256: [{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, { name: 'RSASSA-PKCS1-v1_5' }], EdDSA: [{ name: 'Ed25519' }, { name: 'Ed25519' }] };
const fail = message => invariant(false, 'invalid_dpop_proof', message, 400);
// RFC 7638 thumbprint over the required members, in lexicographic order.
export async function thumbprint(jwk) {
    const members = jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : jwk.kty === 'RSA' ? { e: jwk.e, kty: jwk.kty, n: jwk.n } : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
    return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(members))));
}
// Returns the key thumbprint, or null when no proof was sent. `accessToken` adds the ath check (resource servers).
export async function verifyDpop(env, request, url, { accessToken } = {}) {
    const values = request.headers.get('dpop');
    if (values === null) return null;
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(values) || values.length > 8192) fail('Malformed DPoP proof.');
    const [h, c, s] = values.split('.');
    let header, claims;
    try { [header, claims] = [h, c].map(p => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(from64(p)))); } catch { fail('Malformed DPoP proof.'); }
    if (header?.typ !== 'dpop+jwt' || !DPOP_ALGS.includes(header.alg) || !header.jwk || typeof header.jwk !== 'object') fail('DPoP proof needs typ dpop+jwt, a supported alg and a public jwk.');
    const jwk = header.jwk;
    if (jwk.d || jwk.p || jwk.k || !((header.alg === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256') || (header.alg === 'RS256' && jwk.kty === 'RSA') || (header.alg === 'EdDSA' && jwk.kty === 'OKP' && jwk.crv === 'Ed25519'))) fail('DPoP key must be public and match its alg.');
    let valid = false;
    try {
        const { kty, crv, x, y, n, e } = jwk;
        const key = await crypto.subtle.importKey('jwk', Object.fromEntries(Object.entries({ kty, crv, x, y, n, e }).filter(([, v]) => v !== undefined)), ALG[header.alg][0], false, ['verify']);
        valid = await crypto.subtle.verify(ALG[header.alg][1], key, from64(s), new TextEncoder().encode(`${h}.${c}`));
    } catch { fail('Invalid DPoP signature.'); }
    if (!valid) fail('Invalid DPoP signature.');
    const now = Math.floor(Date.now() / 1000), target = new URL(url);
    if (claims?.htm !== request.method || claims.htu !== target.origin + target.pathname) fail('DPoP proof is for another method or URL.');
    if (!Number.isInteger(claims.iat) || claims.iat > now + 60 || claims.iat < now - 300) fail('DPoP proof is not fresh.');
    if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 200) fail('DPoP proof needs a jti.');
    if (accessToken !== undefined && claims.ath !== b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)))) fail('DPoP proof is for another access token.');
    const jkt = await thumbprint(jwk);
    const fresh = await env.DB.prepare('INSERT INTO dpop_proofs(jti_hash,expires_at) VALUES(?,?) ON CONFLICT(jti_hash) DO NOTHING RETURNING jti_hash')
        .bind(await sha256(`${jkt}\n${claims.jti}`), (now + 360) * 1000).first();
    if (!fresh) fail('DPoP proof already used.');
    return jkt;
}
