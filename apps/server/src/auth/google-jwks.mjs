import { invariant } from '../lib/errors.mjs';
import { googleJson } from './google-http.mjs';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
// Only Google's public key data is cached, per database binding (it is the same for every realm). No request data is shared.
const caches = new WeakMap();
async function fetchKeys(env) {
    const { data, headers } = await googleJson(JWKS_URL);
    invariant(data && Array.isArray(data.keys) && data.keys.length > 0 && data.keys.length <= 32 &&
        data.keys.every(key => key && typeof key === 'object' && typeof key.kid === 'string'),
        'google_unavailable', 'Invalid Google key set.', 502);
    const cacheControl = headers.get('cache-control') || '';
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
    const age = Number(headers.get('age') || 0);
    const seconds = /(?:no-store|no-cache)/i.test(cacheControl) || !maxAge || !Number.isFinite(age)
        ? 0 : Math.max(0, Math.min(Number(maxAge[1]) - age, 86400));
    const entry = { keys: data.keys, expires: Date.now() + seconds * 1000 };
    caches.set(env.DB, entry);
    return entry;
}
export async function googleKey(env, kid) {
    let entry = caches.get(env.DB);
    const cached = entry && entry.expires > Date.now();
    if (!cached) entry = await fetchKeys(env);
    // One refresh on key rotation; failed refreshes never authorize with stale keys.
    if (cached && !entry.keys.some(key => key.kid === kid)) entry = await fetchKeys(env);
    const matches = entry.keys.filter(key => key.kid === kid);
    const jwk = matches[0];
    invariant(matches.length === 1 && jwk.kty === 'RSA' && jwk.alg === 'RS256' && jwk.use === 'sig' && !jwk.d &&
        (!jwk.key_ops || (Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))),
    'invalid_grant', 'Invalid Google signing key.', 401);
    try { return await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); }
    catch { invariant(false, 'invalid_grant', 'Invalid Google signing key.', 401); }
}
