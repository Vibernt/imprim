import { from64, safeEqual } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { googleKey } from './google-jwks.mjs';
import { googleJson } from './google-http.mjs';
export async function verifyGoogleToken(env, token, nonce) {
    invariant(typeof token === 'string' && token.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),
        'invalid_grant', 'Invalid Google ID token.', 401);
    const parts = token.split('.');
    let header, claims;
    try {
        const decode = value => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(from64(value)));
        header = decode(parts[0]); claims = decode(parts[1]);
    } catch { invariant(false, 'invalid_grant', 'Invalid Google ID token.', 401); }
    invariant(header && header.alg === 'RS256' && typeof header.kid === 'string' && header.kid.length > 0 && header.kid.length <= 256 &&
        !header.crit && !header.jku && !header.jwk && !header.x5u && header.b64 === undefined,
    'invalid_grant', 'Invalid Google token header.', 401);
    const key = await googleKey(env, header.kid);
    let valid = false;
    try { valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, from64(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)); }
    catch { invariant(false, 'invalid_grant', 'Invalid Google signature.', 401); }
    invariant(valid, 'invalid_grant', 'Invalid Google signature.', 401);
    invariant(claims && ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) && claims.aud === env.GOOGLE_CLIENT_ID &&
        (claims.azp === undefined || claims.azp === env.GOOGLE_CLIENT_ID) && Number.isSafeInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) &&
        typeof claims.nonce === 'string' && typeof nonce === 'string' && await safeEqual(claims.nonce, nonce) &&
        typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 255,
    'invalid_grant', 'Invalid Google token claims.', 401);
    invariant(claims.email_verified === true, 'access_denied', 'A verified Google email is required.', 403);
    invariant(claims.hd === undefined || (typeof claims.hd === 'string' && claims.hd.length <= 253), 'invalid_grant', 'Invalid Google hosted domain.', 401);
    return { providerId: claims.sub, email: normalizeEmail(claims.email), hd: claims.hd ?? null };
}
export async function googleProfile(env, code, verifier, nonce) {
    const { data } = await googleJson('https://oauth2.googleapis.com/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
            client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${env.ISSUER}/login/google/callback` }).toString() });
    invariant(data && !data.error && typeof data.id_token === 'string', 'google_unavailable', 'Google exchange refused.', 502);
    return verifyGoogleToken(env, data.id_token, nonce);
}
