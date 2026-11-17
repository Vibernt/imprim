import { invariant } from '../lib/errors.mjs';
import { from64 } from '../lib/crypto.mjs';
import { jwksDocument, ALGORITHMS } from './keys.mjs';
// Verify one of our own ID tokens, given back as a hint, against the fixed local ring; never trust token-selected
// algorithms or key URLs. Expiry is the caller's decision: a hint may name a session after its ID token expired.
export async function ownIdToken(env, token, what = 'ID token hint') {
    invariant(typeof token === 'string' && token.length <= 8192, 'invalid_request', `Invalid ${what}.`);
    const parts = token.split('.');
    invariant(parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)), 'invalid_request', `Invalid ${what}.`);
    let header, claims;
    try {
        header = JSON.parse(new TextDecoder().decode(from64(parts[0])));
        claims = JSON.parse(new TextDecoder().decode(from64(parts[1])));
    } catch { invariant(false, 'invalid_request', `Invalid ${what}.`); }
    invariant(Object.hasOwn(ALGORITHMS, header?.alg) && header.typ === 'JWT' && typeof header.kid === 'string' && !header.jku && !header.jwk && !header.x5u && !header.crit,
        'invalid_request', `Unsupported ${what} header.`);
    // The key decides the algorithm: a header naming another one than its key's is refused, never reinterpreted.
    const jwk = (await jwksDocument(env)).keys.find(key => key.kid === header.kid);
    invariant(jwk, 'invalid_request', `Unknown ${what} signing key.`);
    invariant(jwk.alg === header.alg, 'invalid_request', `Unsupported ${what} header.`);
    const { key: keyAlgorithm, sign } = ALGORITHMS[jwk.alg];
    const key = await crypto.subtle.importKey('jwk', jwk, keyAlgorithm, false, ['verify']);
    let valid = false;
    try { valid = await crypto.subtle.verify(sign, key, from64(parts[2]), new TextEncoder().encode(parts.slice(0,2).join('.'))); }
    catch { invariant(false, 'invalid_request', `Malformed ${what} signature.`); }
    invariant(valid, 'invalid_request', `Invalid ${what} signature.`);
    const now = Math.floor(Date.now() / 1000);
    invariant(claims?.iss === env.ISSUER && typeof claims.aud === 'string' && claims.azp === claims.aud &&
        typeof claims.sub === 'string' && typeof claims.sid === 'string' &&
        Number.isInteger(claims.iat) && claims.iat <= now + 60 && Number.isInteger(claims.exp) && claims.exp > claims.iat,
        'invalid_request', `Invalid ${what} claims.`);
    return claims;
}
export async function logoutHint(env, token, session) {
    const claims = await ownIdToken(env, token, 'logout hint'), now = Math.floor(Date.now() / 1000);
    // An expired ID token can identify the currently logged-in session, as RP-Initiated Logout allows.
    invariant(claims.exp > now || (session?.sid === claims.sid && session.user_id === claims.sub), 'invalid_request', 'Expired logout hint without its active session.');
    invariant(!session || (session.sid === claims.sid && session.user_id === claims.sub), 'invalid_request', 'Logout hint does not match this browser session.');
    return claims;
}
