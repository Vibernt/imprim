import { invariant } from '../lib/errors.mjs';
import { readBody, redirect } from '../lib/http.mjs';
import { getSession, requireCsrf } from '../auth/session.mjs';
import { revokeGrant, queueRevocation } from './revocation.mjs';
import { realmId } from '../realms/realm.mjs';

const PAGE = 50;
export async function revokeConnectedAgent(env, ctx, session, { grant_id }) {
    invariant(typeof grant_id === 'string' && grant_id.length > 0 && grant_id.length <= 64, 'invalid_request', 'Choose an agent to revoke.');
    const owned = await env.DB.prepare(`SELECT 1 FROM agent_grants g JOIN clients c ON c.id=g.app_id
        WHERE g.id=? AND g.user_id=? AND c.realm_id=?`).bind(grant_id, session.user_id, realmId(env)).first();
    invariant(owned, 'access_denied', 'That agent isn’t connected to your account. Reload the page.', 403);
    queueRevocation(env, ctx, await revokeGrant(env, grant_id, session.user_id));
}

export async function account(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return to your account.', 401);
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    await revokeConnectedAgent(env, ctx, session, body);
    return redirect(`${env.ISSUER}/account/agents`);
}

export async function labelConnectedAgent(env, session, { grant_id, label }) {
    invariant(typeof label === 'string' && !/\p{Cc}/u.test(label), 'invalid_request', 'Enter a name of up to 60 characters without control characters.');
    const name = label.trim();
    invariant([...name].length <= 60, 'invalid_request', 'Enter a name of up to 60 characters without control characters.');
    const realm = realmId(env);
    const result = await env.DB.batch([
        env.DB.prepare(`UPDATE agent_grants SET label=? WHERE id=? AND user_id=?
            AND app_id IN (SELECT id FROM clients WHERE realm_id=?)`)
            .bind(name || null, typeof grant_id === 'string' ? grant_id : null, session.user_id, realm),
        env.DB.prepare(`INSERT INTO audit(event,actor,detail,created,realm_id)
            SELECT 'agent_grant_label',?,?,?,? WHERE changes()=1`)
            .bind(session.user_id, JSON.stringify({ grant_id }), Date.now(), realm)
    ]);
    invariant(result[0].meta.changes === 1, 'not_found', 'Connection not found.', 404);
}

// Keyset pagination keeps the page bounded even when a person has many grants (S5).
export async function readConnectedAgents(env, session, before = '', status) {
    invariant(before === '' || /^\d{1,16}:[0-9a-f-]{36}$/.test(before), 'invalid_request', 'This page link is broken. Open your account page again.');
    invariant(status === undefined || status === 'active' || status === 'ended', 'invalid_request', 'Choose active or ended connections.');
    const [created, id] = before ? before.split(':') : [Number.MAX_SAFE_INTEGER, ''];
    const now = Date.now(), owner = [session.user_id, realmId(env)];
    const life = status === 'active' ? 'AND g.revoked_at IS NULL AND g.expires_at>?' :
        status === 'ended' ? 'AND (g.revoked_at IS NOT NULL OR g.expires_at<=?)' : '';
    const from = 'FROM agent_grants g JOIN clients c ON c.id=g.app_id';
    const where = 'WHERE g.user_id=? AND c.realm_id=?';
    const [result, total] = await Promise.all([env.DB.prepare(`SELECT g.id,g.client_name,g.registration_method,g.client_id,g.app_id,
        g.resource,g.scope,g.last_used,g.created,g.revoked_at,g.expires_at,g.label,g.approved_device,g.approved_location,c.branding,
        c.agent_scope_catalogue,g.workspace_id,CASE WHEN g.workspace_id IS NULL THEN registered.name ELSE w.name END AS workspace_name,
        CASE WHEN registered.id IS NOT NULL THEN wr.name END AS resource_name,
        (SELECT reason FROM agent_revocation_outbox o WHERE o.grant_id=g.id AND o.app_id=g.app_id
            AND o.user_id=g.user_id AND o.created=g.revoked_at ORDER BY o.id LIMIT 1) AS reason
        ${from}
        LEFT JOIN workspaces w ON w.id=g.workspace_id AND w.realm_id=c.realm_id
        LEFT JOIN workspace_resources wr ON wr.resource=g.resource AND wr.client_id=g.app_id
        LEFT JOIN workspaces registered ON registered.id=wr.workspace_id AND registered.realm_id=c.realm_id
        ${where} ${life} AND (g.created<? OR (g.created=? AND g.id<?)) ORDER BY g.created DESC,g.id DESC LIMIT ?`)
        .bind(...owner, ...(life ? [now] : []), Number(created), Number(created), id || '\uffff', PAGE + 1).all(),
    status === 'ended' ? env.DB.prepare(`SELECT count(*) AS count ${from} ${where} ${life}`).bind(...owner, now).first() : null]);
    const rows = result.results, page = rows.slice(0, PAGE), last = page.at(-1);
    return {
        agents: page.map(grant => connection(grant, now)),
        ...(total ? { total: total.count } : {}),
        next: rows.length > PAGE ? `${last.created}:${last.id}` : null
    };
}

function connection(grant, now) {
    const catalogue = JSON.parse(grant.agent_scope_catalogue);
    const revoked = grant.revoked_at !== null, expired = grant.expires_at <= now;
    const status = revoked ? 'revoked' : expired ? 'expired' : 'active';
    return { id: grant.id, name: grant.client_name, app: JSON.parse(grant.branding).name || grant.app_id,
        host: grant.registration_method === 'dynamic' ? null : new URL(grant.client_id).host,
        workspace_id: grant.workspace_id, workspace_name: grant.workspace_name,
        resource: grant.resource, resource_name: grant.resource_name,
        scopes: grant.scope.split(' ').filter(Boolean).map(code => ({ code, label: Object.hasOwn(catalogue, code) ? catalogue[code] : null })),
        label: grant.label, approved_device: grant.approved_device, approved_location: grant.approved_location,
        last_used: grant.last_used, created: grant.created, expires_at: grant.expires_at, status,
        ended_at: revoked ? grant.revoked_at : expired ? grant.expires_at : null,
        ended_reason: revoked ? grant.reason : expired ? 'expired' : null };
}
