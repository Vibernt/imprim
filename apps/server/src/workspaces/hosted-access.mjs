import { assertOrigin, cookies, CSRF_COOKIE, getSession, requireCsrf } from '../auth/session.mjs';
import { invariant } from '../lib/errors.mjs';
import { readBody, uniqueParams } from '../lib/http.mjs';
import { authorizationResponse, pendingRequest, requireAuthorizationSession } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { workspaceAccessPage } from '../pages/workspace-access.mjs';
import { accessWorkspaces, workspaceAccessGuard } from './access-offer.mjs';

export async function workspaceAccess(request, env) {
    const post = request.method === 'POST';
    if (post) assertOrigin(request, env);
    const body = post ? await readBody(request, 'form') : uniqueParams(new URL(request.url).searchParams);
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    if (post) await requireCsrf(request, env, session, body.csrf);
    const pending = await pendingRequest(env, request, body.request_id);
    const { row, client } = pending;
    requireAuthorizationSession(row, session);
    requireMethod(client, session.method, session.google_hd, true);
    const state = JSON.parse(row.workspace_access);
    invariant(!row.agent_client_id && row.prompt !== 'none' && state?.product && state.product === client.product,
        'access_denied', 'Workspace access is unavailable for this sign-in request.', 403);
    const guard = workspaceAccessGuard(env, pending, session, Date.now());
    if (post) {
        const claimed = await env.DB.prepare(`DELETE FROM auth_requests WHERE ${guard.sql} RETURNING *`).bind(...guard.args).first();
        invariant(claimed, 'invalid_request', 'This request was already answered or has expired.');
        return authorizationResponse(env, claimed, { error: 'access_denied' });
    }
    const [live, workspaces] = await env.DB.batch([
        env.DB.prepare(`SELECT 1 FROM auth_requests WHERE ${guard.sql}`).bind(...guard.args),
        accessWorkspaces(env, client, session.user_id)
    ]);
    invariant(live.results.length && workspaces.results.length, 'access_denied', 'Workspace access is unavailable for this sign-in request.', 403);
    return workspaceAccessPage(env, pending, session.email, cookies(request)[CSRF_COOKIE], workspaces.results);
}
