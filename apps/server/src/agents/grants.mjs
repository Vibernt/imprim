import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256, b64url } from '../lib/crypto.mjs';
import { signingKey } from '../oidc/keys.mjs';
import { checkPolicy } from './policy.mjs';
export async function grantContext(env, id) {
    const grant = await env.DB.prepare(`SELECT g.* FROM agent_grants g JOIN users u ON u.id=g.user_id
        WHERE g.id=? AND g.revoked_at IS NULL AND g.expires_at>? AND u.status='active' AND u.merged_into IS NULL`).bind(id, Date.now()).first();
    invariant(grant, 'invalid_grant', 'Grant expired, revoked, or unavailable.');
    const context = await checkPolicy(env, grant, grant);
    invariant(grant.created + context.settings.agent_max_grant_days * 86400000 > Date.now(), 'invalid_grant', 'Grant exceeds current lifetime policy.');
    grant.expires_at = Math.min(grant.expires_at, grant.created + context.settings.agent_max_grant_days * 86400000);
    return { grant, ...context };
}
export async function signAgentJwt(env, claims, typ = 'at+jwt') {
    const { kid, key } = await signingKey(env);
    const encode = value => b64url(new TextEncoder().encode(JSON.stringify(value)));
    const input = `${encode({ alg: 'ES256', typ, kid })}.${encode(claims)}`;
    return `${input}.${b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)))}`;
}
// `scope` may narrow the access token (RFC 6749 section 6); the refresh token always keeps the grant's scope.
// `jkt` binds the access token to a DPoP key (cnf.jkt, token_type DPoP).
export async function tokenMaterial(env, grant, scope = grant.scope, jkt = null) {
    const now = Math.floor(Date.now() / 1000), refresh = randomToken();
    // Cap even the final access token at the grant deadline.
    const exp = Math.min(now + 60, Math.floor(grant.expires_at / 1000));
    invariant(exp > now, 'invalid_grant', 'Grant has no remaining token lifetime.');
    // grant_issued_at: when the person approved this grant (seconds). It never changes on refresh, so a resource can
    // require a fresh approval (one-shot owner approvals) without trusting iat, which every refresh renews.
    const token = await signAgentJwt(env, { iss: env.ISSUER, aud: grant.resource, sub: grant.user_id,
        client_id: grant.client_id, grant_id: grant.id, grant_issued_at: Math.floor(grant.created / 1000), scope,
        ...(jkt ? { cnf: { jkt } } : {}), jti: crypto.randomUUID(), iat: now, exp });
    return { hash: await sha256(refresh), response: { access_token: token, token_type: jkt ? 'DPoP' : 'Bearer', expires_in: exp - now, refresh_token: refresh, scope } };
}
// A refresh updates last_used but writes no audit row: a running agent refreshes every minute, and the audit log
// would grow without bound (S5). First issuance, revocation and reuse are audited.
export function usageStatements(env, grant, event) {
    const now = Date.now();
    return [
        env.DB.prepare('UPDATE agent_grants SET last_used=? WHERE id=?').bind(now, grant.id),
        env.DB.prepare('UPDATE agent_clients SET last_used=? WHERE id=?').bind(now, grant.client_id),
        ...(event === 'agent_refresh' ? [] : [env.DB.prepare('INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,?,?,?)').bind(event, grant.user_id, JSON.stringify({ grant_id: grant.id, app_id: grant.app_id }), now, env.REALM?.id ?? null)])
    ];
}
// DPoP policy for a token request: the proof's key, or null. A grant bound to a key (dpop_jkt) needs a proof from that
// key on every request; an app with agent_dpop 'required' needs a proof from the first.
export function dpopFor(app, grant, jkt) {
    invariant(app.agent_dpop !== 'required' || jkt, 'invalid_dpop_proof', 'This app requires DPoP-bound tokens.', 400);
    invariant(!grant?.dpop_jkt || grant.dpop_jkt === jkt, 'invalid_dpop_proof', 'This grant is bound to another DPoP key.', 400);
    return jkt;
}
// Binds only together with a successful issuance: the new refresh token must exist in the same transaction.
export const bindStatement = (env, grant, jkt, refreshHash) => env.DB.prepare(`UPDATE agent_grants SET dpop_jkt=? WHERE id=? AND (dpop_jkt IS NULL OR dpop_jkt=?)
    AND EXISTS(SELECT 1 FROM agent_refresh_tokens WHERE hash=? AND grant_id=agent_grants.id)`).bind(jkt, grant.id, jkt, refreshHash);
