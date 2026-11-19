import { cookies, CSRF_COOKIE, getSession, requireCsrf } from '../auth/session.mjs';
import { invariant } from '../lib/errors.mjs';
import { readBody, uniqueParams } from '../lib/http.mjs';
import { authorizationResponse, completeAuthorization, pendingRequest, requireAuthorizationSession } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { workspaceJoinPage } from '../pages/workspace-join.mjs';
import { realmId } from '../realms/realm.mjs';
import { liveActorSession } from './actor.mjs';
import { liveWorkspaceJoin, workspaceJoinRequestGuard } from './join-policy.mjs';
import { setWorkspaceProducts } from './model.mjs';
import { joinableTeamWorkspaces } from './queries.mjs';

export async function workspaceJoin(request, env) {
    const post = request.method === 'POST';
    const body = post ? await readBody(request, 'form') : uniqueParams(new URL(request.url).searchParams);
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    if (post) await requireCsrf(request, env, session, body.csrf);
    const pending = await pendingRequest(env, request, body.request_id);
    const { row, client } = pending;
    const state = JSON.parse(row.workspace_join);
    requireAuthorizationSession(row, session);
    requireMethod(client, session.method, session.google_hd, true);
    invariant(state?.product && state.product === client.product && await liveWorkspaceJoin(env, pending),
        'access_denied', 'Workspace join is unavailable for this sign-in request.', 403);
    if (!post) {
        const workspaces = await joinableTeamWorkspaces(env, realmId(env), session.user_id, client.product, state.workspace_ids.length, state.workspace_ids);
        return workspaceJoinPage(env, pending, cookies(request)[CSRF_COOKIE], workspaces);
    }
    const now = Date.now(), guard = workspaceJoinRequestGuard(env, pending, now);
    if (body.action === 'decline') {
        const { meta } = await env.DB.prepare(`DELETE FROM auth_requests WHERE ${guard.sql}
            AND EXISTS(SELECT 1 ${liveActorSession})`)
            .bind(...guard.args, session.sid, session.user_id, now, realmId(env)).run();
        invariant(meta.changes === 1, 'invalid_request', 'This request was already answered or has expired.');
        return authorizationResponse(env, row, { error: 'access_denied' });
    }
    invariant(body.action === 'join', 'invalid_request', 'Choose Use this workspace or Not now.');
    const id = body.workspace_id;
    invariant(state.workspace_ids.includes(id), 'not_found', 'Workspace not found.', 404);
    const claim = env.DB.prepare(`UPDATE auth_requests SET workspace_join=json_remove(workspace_join,'$.product','$.workspace_ids') WHERE id=?`)
        .bind(row.id);
    await setWorkspaceProducts(env, client, { user: { id: session.user_id }, session }, id,
        { add: [client.product], remove: [] }, { guard: { sql: `EXISTS(SELECT 1 FROM auth_requests WHERE ${guard.sql})`, args: guard.args }, claim });
    return completeAuthorization(env, request, row.id, session);
}
