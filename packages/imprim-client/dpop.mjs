// Resource-server check of a DPoP proof (RFC 9449 §7): signed by the key the token is bound to (cnf.jkt), for this
// method and URL, fresh, and for this exact access token (ath). Deduplicate the returned jti yourself.
const DPOP_IMPORT = { ES256: [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }], RS256: [{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, { name: 'RSASSA-PKCS1-v1_5' }], EdDSA: [{ name: 'Ed25519' }, { name: 'Ed25519' }] };
const dpopB64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dpopUnb64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
export async function verifyDpopProof(proof, { accessToken, jkt, method, url, clockSkewSeconds = 60 }, fail) {
    if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(proof) || proof.length > 8192) fail('invalid_dpop_proof', 'A DPoP proof is required.');
    const [h, c, s] = proof.split('.');
    let header, claims;
    try { [header, claims] = [h, c].map(p => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(dpopUnb64(p)))); } catch { fail('invalid_dpop_proof', 'Malformed DPoP proof.'); }
    const jwk = header?.jwk;
    if (header?.typ !== 'dpop+jwt' || !DPOP_IMPORT[header.alg] || !jwk || jwk.d) fail('invalid_dpop_proof', 'Unsupported DPoP proof header.');
    const members = jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : jwk.kty === 'RSA' ? { e: jwk.e, kty: jwk.kty, n: jwk.n } : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
    if (dpopB64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(members)))) !== jkt) fail('invalid_dpop_proof', 'DPoP key does not match the token.');
    let valid = false;
    try {
        const key = await crypto.subtle.importKey('jwk', members, DPOP_IMPORT[header.alg][0], false, ['verify']);
        valid = await crypto.subtle.verify(DPOP_IMPORT[header.alg][1], key, dpopUnb64(s), new TextEncoder().encode(`${h}.${c}`));
    } catch { fail('invalid_dpop_proof', 'Invalid DPoP signature.'); }
    if (!valid) fail('invalid_dpop_proof', 'Invalid DPoP signature.');
    const target = new URL(url), now = Math.floor(Date.now() / 1000);
    if (claims?.htm !== method || claims.htu !== target.origin + target.pathname) fail('invalid_dpop_proof', 'DPoP proof is for another method or URL.');
    if (!Number.isInteger(claims.iat) || claims.iat > now + clockSkewSeconds || claims.iat < now - 300) fail('invalid_dpop_proof', 'DPoP proof is not fresh.');
    if (claims.ath !== dpopB64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)))) fail('invalid_dpop_proof', 'DPoP proof is for another access token.');
    if (typeof claims.jti !== 'string' || !claims.jti) fail('invalid_dpop_proof', 'DPoP proof needs a jti.');
    return claims.jti;
}
