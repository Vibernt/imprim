import { validateAccessClaims } from './resources.mjs';
import { validateBackchannelClaims } from './backchannel.mjs';
export function createVerifier({ keys, issuerText, clientId, resourcePrefixes, fail }) {
    let unknownAt = -Infinity;
    const bytes = value => new TextEncoder().encode(value);
    function unb64(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) fail('invalid_token', 'Malformed base64url.');
        try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0)); }
        catch { fail('invalid_token', 'Malformed base64url.'); }
    }
    function jsonPart(value) {
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unb64(value))); }
        catch { fail('invalid_token', 'Malformed JWT JSON.'); }
    }
    async function verify(jwt, { nonce, maxAge, logout = false, access = false, revocation = false, audience, clockSkewSeconds } = {}) {
        if (typeof jwt !== 'string') fail('invalid_token', 'JWT required.');
        const parts = jwt.split('.');
        if (parts.length !== 3) fail('invalid_token', 'Malformed JWT.');
        const header = jsonPart(parts[0]), claims = jsonPart(parts[1]);
        if (header?.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid || header.crit || header.jku || header.x5u) fail('invalid_token', 'Unsupported JWT header.');
        let key = (await keys()).find(item => item.kid === header.kid);
        if (!key && Date.now() - unknownAt >= 60000) { unknownAt = Date.now(); key = (await keys(true)).find(item => item.kid === header.kid); }
        if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' || key.use !== 'sig' || !key.x || !key.y) fail('invalid_token', 'Unknown or invalid signing key.');
        let verified = false;
        try {
            const imported = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, unb64(parts[2]), bytes(`${parts[0]}.${parts[1]}`));
        } catch { fail('invalid_token', 'Invalid signing key or signature.'); }
        if (!verified) fail('invalid_token', 'Invalid signature.');
        if (!claims || typeof claims !== 'object' || Array.isArray(claims)) fail('invalid_token', 'Invalid JWT claims.');
        if (access) return validateAccessClaims(header, claims, audience, issuerText, fail, clockSkewSeconds);
        if (logout || revocation) return validateBackchannelClaims(header, claims, { issuer: issuerText, clientId, resourcePrefixes, clockSkewSeconds }, logout ? 'logout' : 'revocation', fail);
        if (header.typ === 'at+jwt') fail('invalid_token', 'Access tokens cannot be used as ID or logout tokens.');
        const now = Math.floor(Date.now() / 1000), aud = claims.aud;
        if (claims.iss !== issuerText || !(aud === clientId || (Array.isArray(aud) && aud.includes(clientId) && aud.every(x => typeof x === 'string'))) || (Array.isArray(aud) && aud.length > 1 && claims.azp !== clientId) || (claims.azp !== undefined && claims.azp !== clientId)) fail('invalid_token', 'Issuer or audience mismatch.');
        if ((typeof claims.sub !== 'string' || !claims.sub) || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp <= now - 60 || claims.iat > now + 60 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60))) fail('invalid_token', 'Invalid token claims or time.');
        if (typeof nonce !== 'string' || !nonce || claims.nonce !== nonce) fail('invalid_token', 'Nonce mismatch.');
        if (maxAge !== undefined && (!Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(claims.auth_time) || claims.auth_time > now + 60 || claims.auth_time + maxAge < now - 60)) fail('invalid_token', 'Authentication too old.');
        return claims;
    }
    return verify;
}
