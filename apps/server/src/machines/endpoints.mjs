// RFC 7662 introspection, RFC 7009 revocation, and the app-side grant API. An app only ever sees or changes tokens
// and grants for resources it owns.
import { invariant } from '../lib/errors.mjs';
import { json, readBody, tokenShape, uniqueParams } from '../lib/http.mjs';
import { from64, sha256 } from '../lib/crypto.mjs';
import { authenticatedClient } from '../oidc/token.mjs';
import { jwksDocument } from '../oidc/keys.mjs';
import { ownerOf, } from '../agents/policy.mjs';
import { resolveAgent } from '../agents/registration.mjs';
import { authenticateAgent } from '../agents/client-auth.mjs';
import { revokeGrant, queueRevocation } from '../agents/revocation.mjs';
import { resourceUrl } from '../agents/uris.mjs';
import { limitAddress } from '../auth/rate-limit.mjs';
import { realmId } from '../realms/realm.mjs';
// Verifies one of this realm's access tokens (at+jwt, ES256) without trusting anything the token says about keys.
export async function localAccessToken(env, token) {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null;
    let header, claims;
    try { [header, claims] = parts.slice(0, 2).map(p => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(from64(p)))); } catch { return null; }
    if (header?.alg !== 'ES256' || header.typ !== 'at+jwt' || typeof header.kid !== 'string' || header.jku || header.jwk || header.x5u || header.crit) return null;
    const jwk = (await jwksDocument(env)).keys.find(key => key.kid === header.kid);
    if (!jwk) return null;
    try {
        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, from64(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return null;
    } catch { return null; }
    const now = Math.floor(Date.now() / 1000);
    if (claims?.iss !== env.ISSUER || typeof claims.aud !== 'string' || !Number.isInteger(claims.exp) || claims.exp <= now) return null;
    return claims;
}
export async function stillLive(env, claims) {
    if (typeof claims.grant_id !== 'string') return false;
    if (claims.grant_id.startsWith('service:')) {
        return Boolean(await env.DB.prepare("SELECT 1 FROM service_clients WHERE id=? AND realm_id=? AND status='active'").bind(claims.grant_id.slice(8), realmId(env)).first());
    }
    return Boolean(await env.DB.prepare(`SELECT 1 FROM agent_grants g JOIN users u ON u.id=g.user_id WHERE g.id=? AND g.revoked_at IS NULL AND g.expires_at>?
        AND u.status='active' AND u.merged_into IS NULL AND u.realm_id=?`).bind(claims.grant_id, Date.now(), realmId(env)).first());
}
const owns = async (env, client, resource) => { try { return (await ownerOf(env, resource)).id === client.id; } catch { return false; } };
export async function introspect(request, env) {
    const body = await readBody(request, 'form'), client = await authenticatedClient(request, env, body, true);
    const claims = await localAccessToken(env, body.token);
    if (!claims || !await owns(env, client, claims.aud) || !await stillLive(env, claims)) return json({ active: false });
    const { iss, sub, aud, scope, client_id, grant_id, exp, iat, act, cnf, grant_issued_at } = claims;
    return json({ active: true, token_type: cnf ? 'DPoP' : 'Bearer', iss, sub, aud, scope, client_id, grant_id, exp, iat,
        ...(grant_issued_at ? { grant_issued_at } : {}), ...(act ? { act } : {}), ...(cnf ? { cnf } : {}) });
}
// RFC 7009: always 200. An agent revokes its own grant (by refresh or access token); an app revokes grants on its
// own resources. Anything else is ignored without saying why.
export async function revoke(request, env, ctx) {
    const body = await readBody(request, 'form');
    let app = null;
    if (request.headers.has('authorization')) app = await authenticatedClient(request, env, body, true);
    else await limitAddress(env, request);
    let grant = null;
    if (tokenShape(body.token)) {
        grant = await env.DB.prepare('SELECT g.* FROM agent_refresh_tokens t JOIN agent_grants g ON g.id=t.grant_id WHERE t.hash=?').bind(await sha256(body.token)).first();
    } else {
        const claims = await localAccessToken(env, body.token);
        if (claims && typeof claims.grant_id === 'string' && !claims.grant_id.startsWith('service:'))
            grant = await env.DB.prepare('SELECT * FROM agent_grants WHERE id=?').bind(claims.grant_id).first();
    }
    if (!grant || grant.revoked_at !== null) return new Response(null, { status: 200 });
    if (app) { if (grant.app_id !== app.id) return new Response(null, { status: 200 }); }
    else {
        if (grant.client_id !== body.client_id) return new Response(null, { status: 200 });
        await authenticateAgent(env, await resolveAgent(env, grant.client_id), body, '/revoke');
    }
    queueRevocation(env, ctx, await revokeGrant(env, grant.id, grant.user_id, app ? 'app_revoke' : 'agent_self_revoke'));
    return new Response(null, { status: 200 });
}
// GET /v1/grants?resource=…: the live agent grants on one of this app's resources (a workspace admin's view).
// POST /v1/grants/revoke {grant_id}: revoke one, for example when a member leaves the workspace.
export async function appGrants(request, env, ctx) {
    if (request.method === 'GET') {
        const query = uniqueParams(new URL(request.url).searchParams), client = await authenticatedClient(request, env, {}, true);
        resourceUrl(query.resource);
        invariant(await owns(env, client, query.resource), 'invalid_target', 'That resource does not belong to this app.', 403);
        const { results } = await env.DB.prepare(`SELECT id,user_id,client_id,client_name,registration_method,scope,created,last_used,expires_at FROM agent_grants
            WHERE app_id=? AND resource=? AND revoked_at IS NULL AND expires_at>? ORDER BY created DESC LIMIT 200`).bind(client.id, query.resource, Date.now()).all();
        return json({ grants: results.map(g => ({ grant_id: g.id, sub: g.user_id, agent: g.client_id, agent_name: g.client_name,
            agent_verified: g.registration_method === 'metadata_document', scope: g.scope, created: g.created, last_used: g.last_used, expires_at: g.expires_at })) });
    }
    const body = await readBody(request, 'form'), client = await authenticatedClient(request, env, body, true);
    invariant(typeof body.grant_id === 'string' && body.grant_id.length <= 64, 'invalid_request', 'grant_id required.');
    const grant = await env.DB.prepare('SELECT * FROM agent_grants WHERE id=? AND app_id=?').bind(body.grant_id, client.id).first();
    invariant(grant, 'not_found', 'Grant not found for this app.', 404);
    const event = await revokeGrant(env, grant.id, grant.user_id, 'app_revoke');
    queueRevocation(env, ctx, event);
    return json({ grant_id: grant.id, revoked: true });
}
