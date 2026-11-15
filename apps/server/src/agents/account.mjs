import { invariant } from '../lib/errors.mjs';
import { readBody, redirect } from '../lib/http.mjs';
import { getSession, requireCsrf } from '../auth/session.mjs';
import { escapeHtml as e } from '../pages/layout.mjs';
import { badge, status, table, empty, linkButton, code, hidden } from '../pages/ui.mjs';
import { accountHome, rowAction, when, day } from '../account/home.mjs';
import { workspace } from './uris.mjs';
import { revokeGrant, queueRevocation } from './revocation.mjs';
const PAGE = 50;
export async function account(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return to your account.', 401);
    if (request.method === 'POST') {
        const body = await readBody(request, 'form');
        await requireCsrf(request, env, session, body.csrf);
        invariant(typeof body.grant_id === 'string', 'invalid_request', 'Choose an agent to revoke.');
        const owned = await env.DB.prepare('SELECT 1 FROM agent_grants WHERE id=? AND user_id=?').bind(body.grant_id, session.user_id).first();
        invariant(owned, 'access_denied', 'That agent isn’t connected to your account. Reload the page.', 403);
        queueRevocation(env, ctx, await revokeGrant(env, body.grant_id, session.user_id));
        return redirect(`${env.ISSUER}/account/agents`);
    }
    return accountHome(request, env, session);
}
// The connected agents on /account/agents, paged by (created, id) so many grants still give a bounded page (S5).
export async function agentsList(request, env, session) {
    // Paged by (created, id) so a person with many grants gets a bounded page (S5).
    const before = new URL(request.url).searchParams.get('before') || '';
    invariant(before === '' || /^\d{1,16}:[0-9a-f-]{36}$/.test(before), 'invalid_request', 'This page link is broken. Open your account page again.');
    const [created, id] = before ? before.split(':') : [Number.MAX_SAFE_INTEGER, ''];
    const { results: rows } = await env.DB.prepare(`SELECT g.*,c.branding FROM agent_grants g JOIN clients c ON c.id=g.app_id
        WHERE g.user_id=? AND (g.created<? OR (g.created=? AND g.id<?)) ORDER BY g.created DESC,g.id DESC LIMIT ?`)
        .bind(session.user_id, Number(created), Number(created), id || '\uffff', PAGE + 1).all();
    const results = rows.slice(0, PAGE), last = results.at(-1);
    const more = rows.length > PAGE ? `<div class="fd-row" data-justify="center">${linkButton('Older agents', `/account/agents?before=${last.created}:${last.id}`, { variant: 'ghost' })}</div>` : '';
    const stack = (...lines) => `<div class="fd-stack" data-gap="1">${lines.join('')}</div>`;
    const rowsHtml = results.map(g => {
        const app = JSON.parse(g.branding).name || g.app_id;
        return [
            stack(`<span class="fd-label">${e(g.client_name)}</span>`, g.registration_method === 'dynamic' ? `<span>${badge('Unverified', 'warning')}</span>` : `<span class="fd-mono-sm fd-muted">${e(new URL(g.client_id).host)}</span>`),
            stack(`<span>${e(app)}</span>`, `<span class="fd-small fd-muted">${e(`Workspace: ${workspace(g.resource)}`)}</span>`, `<span class="fd-mono-sm fd-muted">${e(g.resource)}</span>`),
            `<div class="fd-row" data-wrap data-gap="1">${String(g.scope).split(' ').filter(Boolean).map(code).join('')}</div>`,
            stack(`<span>${e(when(g.last_used))}</span>`, `<span class="fd-small fd-muted">${e(`Connected ${day(g.created)}`)}</span>`),
            g.revoked_at ? status('Revoked') : g.expires_at <= Date.now() ? status('Expired', 'warning')
                : rowAction(request, '/account/revoke', hidden('grant_id', g.id), 'Revoke', { variant: 'danger-soft', 'aria-label': `Revoke ${g.client_name}` })
        ];
    });
    return results.length ? table('Connected agents', ['Agent', 'App', 'Scopes', 'Last used', 'Access'], rowsHtml) + more
        : empty('No agents connected', 'Agents you approve to act in an app appear here.');
}
