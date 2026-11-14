import { invariant } from '../lib/errors.mjs';
import { readBody, redirect } from '../lib/http.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE } from '../auth/session.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { hidden } from './consent.mjs';
import { workspace } from './uris.mjs';
import { revokeGrant, queueRevocation } from './revocation.mjs';
const PAGE = 50;
export async function account(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return to your account.', 401);
    if (request.method === 'POST') {
        const body = await readBody(request, 'form');
        await requireCsrf(request, env, session, body.csrf);
        invariant(typeof body.grant_id === 'string', 'invalid_request', 'Grant required.');
        const owned = await env.DB.prepare('SELECT 1 FROM agent_grants WHERE id=? AND user_id=?').bind(body.grant_id, session.user_id).first();
        invariant(owned, 'access_denied', 'Grant unavailable.', 403);
        queueRevocation(env, ctx, await revokeGrant(env, body.grant_id, session.user_id));
        return redirect(`${env.ISSUER}/account`);
    }
    // Paged by (created, id) so a person with many grants gets a bounded page (S5).
    const before = new URL(request.url).searchParams.get('before') || '';
    invariant(before === '' || /^\d{1,16}:[0-9a-f-]{36}$/.test(before), 'invalid_request', 'Invalid page cursor.');
    const [created, id] = before ? before.split(':') : [Number.MAX_SAFE_INTEGER, ''];
    const { results: rows } = await env.DB.prepare(`SELECT g.*,c.branding FROM agent_grants g JOIN clients c ON c.id=g.app_id
        WHERE g.user_id=? AND (g.created<? OR (g.created=? AND g.id<?)) ORDER BY g.created DESC,g.id DESC LIMIT ?`)
        .bind(session.user_id, Number(created), Number(created), id || '\uffff', PAGE + 1).all();
    const results = rows.slice(0, PAGE), last = results.at(-1);
    const more = rows.length > PAGE ? `<p><a href="/account?before=${e(`${last.created}:${last.id}`)}">Older agents</a></p>` : '';
    return page('Connected agents', `<h1>Connected agents</h1>${results.length ? results.map(g => `<section><h2>${e(g.client_name)}</h2>
<p>${e(g.registration_method === 'dynamic' ? 'unverified' : new URL(g.client_id).host)}</p>
<p>App: ${e(JSON.parse(g.branding).name || g.app_id)} · Workspace: ${e(workspace(g.resource))}</p>
<p>${e(g.resource)}</p><p>Scopes: ${e(g.scope)}</p><p>Created: ${e(new Date(g.created).toISOString())}<br>Last used: ${e(new Date(g.last_used).toISOString())}</p>
${g.revoked_at ? '<p>Revoked</p>' : g.expires_at <= Date.now() ? '<p>Expired</p>' : `<form method="post" action="/account/revoke">${hidden('grant_id', g.id)}${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}<button>Revoke</button></form>`}</section>`).join('') + more : '<p>No agents connected.</p>'}`);
}
