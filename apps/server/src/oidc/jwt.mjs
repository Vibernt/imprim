// ES256 compact signing ported from Assay services/workload-identity.mjs.
import { signingKey } from './keys.mjs';
import { b64url } from '../lib/crypto.mjs';
export async function signIdToken(env, session, code) {
    const { kid, key } = await signingKey(env), now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: env.ISSUER, aud: code.client_id, azp: code.client_id, sub: session.user_id,
        // Email claims only with the email scope (OIDC Core 5.4).
        ...(code.scope.split(' ').includes('email') ? { email: session.email, email_verified: session.email_verified === 1 } : {}),
        amr: JSON.parse(session.amr || '[]').length ? JSON.parse(session.amr) : [session.method], auth_time: session.auth_time, sid: session.sid,
        nonce: code.nonce, iat: now, exp: now + 600
    };
    const encode = value => b64url(new TextEncoder().encode(JSON.stringify(value)));
    const input = `${encode({ alg: 'ES256', typ: 'JWT', kid })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
    return `${input}.${b64url(signature)}`;
}
