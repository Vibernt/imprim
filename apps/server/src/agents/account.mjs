import { invariant } from '../lib/errors.mjs';
import { readBody, redirect } from '../lib/http.mjs';
import { getSession, requireCsrf } from '../auth/session.mjs';
import { workspace } from './uris.mjs';
import { revokeGrant, queueRevocation } from './revocation.mjs';
import { realmId } from '../realms/realm.mjs';

const PAGE = 50;
export async function revokeConnectedAgent(env, ctx, session, { grant_id }) {
    invariant(typeof grant_id === 'string' && grant_id.length > 0 && grant_id.length <= 64, 'invalid_request', 'Choose an agent to revoke.');
    const owned = await env.DB.prepare('SELECT 1 FROM agent_grants WHERE id=? AND user_id=?').bind(grant_id, session.user_id).first();
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
export async function readConnectedAgents(env, session, before = '') {
    invariant(before === '' || /^\d{1,16}:[0-9a-f-]{36}$/.test(before), 'invalid_request', 'This page link is broken. Open your account page again.');
    const [created, id] = before ? before.split(':') : [Number.MAX_SAFE_INTEGER, ''];
    const { results: rows } = await env.DB.prepare(`SELECT g.id,g.client_name,g.registration_method,g.client_id,g.app_id,
        g.resource,g.scope,g.last_used,g.created,g.revoked_at,g.expires_at,g.label,g.approved_device,g.approved_location,c.branding
        FROM agent_grants g JOIN clients c ON c.id=g.app_id
        WHERE g.user_id=? AND c.realm_id=? AND (g.created<? OR (g.created=? AND g.id<?)) ORDER BY g.created DESC,g.id DESC LIMIT ?`)
        .bind(session.user_id, realmId(env), Number(created), Number(created), id || '\uffff', PAGE + 1).all();
    const page = rows.slice(0, PAGE), last = page.at(-1), now = Date.now();
    return {
        agents: page.map(g => ({ id: g.id, name: g.client_name, app: JSON.parse(g.branding).name || g.app_id,
            host: g.registration_method === 'dynamic' ? null : new URL(g.client_id).host,
            workspace: workspace(g.resource), resource: g.resource, scopes: String(g.scope).split(' ').filter(Boolean),
            label: g.label, approved_device: g.approved_device, approved_location: g.approved_location,
            last_used: g.last_used, created: g.created, status: g.revoked_at ? 'revoked' : g.expires_at <= now ? 'expired' : 'active' })),
        next: rows.length > PAGE ? `${last.created}:${last.id}` : null
    };
}
