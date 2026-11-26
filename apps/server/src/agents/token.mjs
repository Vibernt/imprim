import { liveGrantGuard } from './guards.mjs';
import { invariant } from '../lib/errors.mjs';
import { json, tokenShape } from '../lib/http.mjs';
import { sha256, challengeOf } from '../lib/crypto.mjs';
import { sessionByHash } from '../auth/session.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { admissionGuard } from '../services/admission.mjs';
import { grantContext, tokenMaterial, usageStatements, dpopFor, bindStatement } from './grants.mjs';
import { verifyDpop } from '../machines/dpop.mjs';
import { revokeGrant, queueRevocation } from './revocation.mjs';
import { authenticateAgent } from './client-auth.mjs';
import { pollDevice } from './device.mjs';
import { matchRedirect } from './uris.mjs';
import { resolveAgent } from './registration.mjs';
import { limitAgentGrant } from '../auth/rate-limit.mjs';
import { revokeEndedWorkspaceGrant, workspaceEndRevocation } from './workspace-revocation.mjs';
import { scopedWorkspaceLiveSql } from './workspace-choice.mjs';
// A lost refresh response can be retried for this long without killing the grant (see refresh()).
export const REFRESH_GRACE_MS = 10000;
// A running agent refreshes about 1,440 times a day; this bounds a holder that loops (S5).
export const REFRESH_BUDGET_PER_DAY = 3000;
export async function agentToken(request, env, body, ctx) {
    invariant(!request.headers.has('authorization') && !Object.hasOwn(body, 'client_secret'), 'invalid_client', 'Agents authenticate with private_key_jwt or not at all.');
    invariant(typeof body.client_id === 'string' && typeof body.resource === 'string', 'invalid_target', 'client_id and exactly one resource required.');
    const jkt = await verifyDpop(env, request, `${env.ISSUER}/token`);
    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') return pollDevice(env, body, jkt);
    if (body.grant_type === 'refresh_token') return refresh(env, body, ctx, jkt);
    invariant(body.grant_type === 'authorization_code', 'unsupported_grant_type', 'Unsupported agent grant type.');
    invariant(tokenShape(body.code) && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || ''), 'invalid_grant', 'Code and PKCE verifier required.');
    const hash = await sha256(body.code), challenge = await challengeOf(body.code_verifier);
    const code = await env.DB.prepare('SELECT * FROM agent_codes WHERE hash=? AND expires_at>?').bind(hash, Date.now()).first();
    if (!code) return replayedCode(env, ctx, hash, body);
    invariant(code.challenge === challenge && code.redirect_uri === body.redirect_uri, 'invalid_grant', 'Code or redirect or verifier mismatch.');
    const { grant, app, agent } = await grantContext(env, code.grant_id);
    invariant(grant.client_id === body.client_id && grant.resource === body.resource, 'invalid_grant', 'Code client or resource mismatch.');
    await limitAgentGrant(env, grant, app);
    invariant(agent.grant_types.includes('authorization_code'), 'unauthorized_client', 'Code flow is no longer registered.');
    await authenticateAgent(env, agent, body, '/token');
    matchRedirect(agent, body.redirect_uri);
    const session = await sessionByHash(env, code.session_hash);
    invariant(session && session.user_id === grant.user_id, 'invalid_grant', 'Sign-in session unavailable.');
    requireMethod(app, session.method, session.google_hd, true);
    const bound = dpopFor(app, grant, jkt);
    const material = await tokenMaterial(env, grant, grant.scope, bound), now = Date.now();
    const guard = liveGrantGuard(grant, app, now), admission = admissionGuard('g.user_id', app.id);
    const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO agent_refresh_tokens(hash,grant_id,created) SELECT ?,c.grant_id,? FROM agent_codes c JOIN agent_grants g ON g.id=c.grant_id
            WHERE c.hash=? AND c.expires_at>? AND g.revoked_at IS NULL AND g.expires_at>? AND ${guard.sql} AND ${admission.sql}
            AND EXISTS(SELECT 1 FROM sessions WHERE hash=c.session_hash AND expires_at>?)`).bind(material.hash, now, hash, now, now, ...guard.args, ...admission.args, now),
        env.DB.prepare('INSERT INTO agent_consumed_codes(hash,grant_id,expires_at) SELECT hash,grant_id,? FROM agent_codes WHERE hash=? AND EXISTS(SELECT 1 FROM agent_refresh_tokens WHERE hash=?)')
            .bind(now + 86400000, hash, material.hash),
        env.DB.prepare('DELETE FROM agent_codes WHERE hash=? AND EXISTS(SELECT 1 FROM agent_refresh_tokens WHERE hash=?)').bind(hash, material.hash),
        ...(bound ? [bindStatement(env, grant, bound, material.hash)] : [])
    ]);
    invariant(results[0].meta.changes === 1, 'invalid_grant', 'Code already used or grant revoked.');
    await env.DB.batch(usageStatements(env, grant, 'agent_token'));
    return json(material.response);
}
// A second use of an agent code revokes the grant it created (RFC 9700 section 4.2.4) (S16).
// A key-bound agent's grant is revoked only by a request that proves the key, so a leaked code or token cannot be
// used to deny service to an agent that would otherwise be safe.
async function provesAgent(env, clientId, body) {
    const agent = await resolveAgent(env, clientId);
    await authenticateAgent(env, agent, body, '/token');
}
async function replayedCode(env, ctx, hash, body) {
    const used = await env.DB.prepare('SELECT c.grant_id,g.user_id,g.client_id FROM agent_consumed_codes c JOIN agent_grants g ON g.id=c.grant_id WHERE c.hash=?').bind(hash).first();
    if (used && used.client_id === body.client_id) await provesAgent(env, used.client_id, body);
    if (used) queueRevocation(env, ctx, await revokeGrant(env, used.grant_id, used.user_id, 'agent_code_replay'));
    invariant(false, 'invalid_grant', used ? 'Code already used; the grant it created is revoked.' : 'Code is invalid or expired.');
}
function narrowed(grant, requested) {
    if (requested === undefined) return grant.scope;
    const held = grant.scope.split(' '), asked = typeof requested === 'string' ? requested.split(' ') : [];
    invariant(asked.length > 0 && new Set(asked).size === asked.length && asked.every(scope => held.includes(scope)), 'invalid_scope', 'Refresh can only narrow the granted scopes.');
    return asked.join(' ');
}
async function refresh(env, body, ctx, jkt = null) {
    invariant(tokenShape(body.refresh_token), 'invalid_grant', 'Refresh token required.');
    const hash = await sha256(body.refresh_token), now = Date.now();
    const token = await env.DB.prepare(`SELECT t.*,g.client_id,g.user_id,g.resource,g.workspace_id,
        (g.workspace_id IS NULL OR (${scopedWorkspaceLiveSql('g', 'owner')})) AS workspace_live
        FROM agent_refresh_tokens t JOIN agent_grants g ON g.id=t.grant_id JOIN clients owner ON owner.id=g.app_id
        WHERE t.hash=? AND owner.realm_id=?`).bind(hash, env.REALM.id).first();
    invariant(token && token.client_id === body.client_id && token.resource === body.resource, 'invalid_grant', 'Refresh client or resource mismatch.');
    if (token.workspace_live !== 1) {
        await revokeEndedWorkspaceGrant(env, token.grant_id, token.user_id, token.workspace_id, now);
        invariant(false, 'invalid_grant', 'Workspace access ended.');
    }
    // Grace: a retry of a token spent moments ago, whose replacement was never used, rotates the replacement instead.
    // A thief racing the owner then leaves the owner holding a spent replacement, which trips reuse detection.
    let spending = token;
    if (token.spent_at !== null) {
        const successor = token.spent_at > now - REFRESH_GRACE_MS && token.replacement_hash && token.grace_spent === 0
            ? await env.DB.prepare('SELECT * FROM agent_refresh_tokens WHERE hash=? AND spent_at IS NULL').bind(token.replacement_hash).first() : null;
        if (!successor) {
            await provesAgent(env, token.client_id, body);
            return reuse(env, ctx, token);
        }
        spending = { ...token, ...successor, grace: 1 };
    }
    const { grant, agent, app } = await grantContext(env, token.grant_id);
    await limitAgentGrant(env, grant, app);
    invariant(agent.grant_types.includes('refresh_token'), 'unauthorized_client', 'Refresh is not registered.');
    await authenticateAgent(env, agent, body, '/token');
    const scope = narrowed(grant, body.scope);
    const recent = await env.DB.prepare('SELECT count(*) AS n FROM agent_refresh_tokens WHERE grant_id=? AND created>?').bind(grant.id, now - 86400000).first();
    invariant(recent.n < REFRESH_BUDGET_PER_DAY, 'invalid_grant', 'This grant exceeded its daily refresh budget. Try again later.');
    const bound = dpopFor(app, grant, jkt);
    const material = await tokenMaterial(env, grant, scope, bound);
    // Qualified: an unqualified user_id inside the client_admissions subquery would resolve to that table's own column.
    const guard = liveGrantGuard(grant, app, now), admission = admissionGuard('agent_grants.user_id', app.id);
    const workspaceEnd = grant.workspace_id === null ? null : workspaceEndRevocation(env, grant.id, grant.user_id, grant.workspace_id, now);
    const result = await env.DB.batch([
        env.DB.prepare(`UPDATE agent_refresh_tokens SET spent_at=?,replacement_hash=?,grace_spent=? WHERE hash=? AND spent_at IS NULL
            AND EXISTS(SELECT 1 FROM agent_grants WHERE id=grant_id AND revoked_at IS NULL AND expires_at>? AND ${admission.sql}) AND ${guard.sql}`)
            .bind(now, material.hash, spending.grace ? 1 : 0, spending.hash, now, ...admission.args, ...guard.args),
        env.DB.prepare(`INSERT INTO agent_refresh_tokens(hash,grant_id,created) SELECT ?,grant_id,? FROM agent_refresh_tokens WHERE hash=? AND replacement_hash=?`)
            .bind(material.hash, now, spending.hash, material.hash),
        ...(bound ? [bindStatement(env, grant, bound, material.hash)] : []),
        ...(workspaceEnd?.statements ?? [])
    ]);
    if (workspaceEnd && result.at(-1).meta.changes === 1) {
        queueRevocation(env, ctx, workspaceEnd.eventId);
        invariant(false, 'invalid_grant', 'Workspace access ended.');
    }
    if (result[0].meta.changes !== 1) {
        const current = await env.DB.prepare('SELECT spent_at FROM agent_refresh_tokens WHERE hash=?').bind(spending.hash).first();
        if (current?.spent_at !== null && current?.spent_at !== undefined) return reuse(env, ctx, token);
        invariant(false, 'invalid_grant', 'Grant revoked.');
    }
    await env.DB.batch(usageStatements(env, grant, 'agent_refresh'));
    return json(material.response);
}
async function reuse(env, ctx, token) {
    queueRevocation(env, ctx, await revokeGrant(env, token.grant_id, token.user_id, 'agent_refresh_reuse'));
    invariant(false, 'invalid_grant', 'Refresh token reuse revoked the whole grant.');
}
