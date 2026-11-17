// Compact JWS signing with the realm's ES256 or RS256 ring.
import { signingKey } from './keys.mjs';
import { b64url } from '../lib/crypto.mjs';
const encode = value => b64url(new TextEncoder().encode(JSON.stringify(value)));
export async function signJwt(env, claims, { typ = 'JWT', alg = 'ES256' } = {}) {
    const { kid, key, params } = await signingKey(env, Date.now(), alg);
    const input = `${encode({ alg, typ, kid })}.${encode(claims)}`;
    return `${input}.${b64url(await crypto.subtle.sign(params, key, new TextEncoder().encode(input)))}`;
}
// alg is the app's id_token_signed_response_alg.
export async function signIdToken(env, session, code, alg = 'ES256') {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: env.ISSUER, aud: code.client_id, azp: code.client_id, sub: session.user_id,
        // Email claims only with the email scope (OIDC Core 5.4).
        ...(code.scope.split(' ').includes('email') ? { email: session.email, email_verified: session.email_verified === 1 } : {}),
        ...(code.scope.split(' ').includes('profile') && session.display_name ? { name: session.display_name } : {}),
        amr: JSON.parse(session.amr || '[]').length ? JSON.parse(session.amr) : [session.method], auth_time: session.auth_time, acr: session.mfa_at ? 'urn:imprim:acr:mfa' : 'urn:imprim:acr:sf', sid: session.sid,
        // A classic app may send no nonce; then the ID token carries none (OIDC Core 3.1.3.6).
        ...(code.nonce ? { nonce: code.nonce } : {}), iat: now, exp: now + 600
    };
    return signJwt(env, claims, { alg });
}
