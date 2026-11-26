import { assertOrigin, getSession, requireCsrf } from './session.mjs';
import { invariant } from '../lib/errors.mjs';
import { readBody, redirect } from '../lib/http.mjs';
import { endIdentitySession } from '../oidc/logout.mjs';
import { pendingRequest } from '../oidc/requests.mjs';
import { signInAgainHref } from '../pages/next-steps.mjs';

export async function switchAccount(request, env, ctx) {
    assertOrigin(request, env);
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    const { row } = await pendingRequest(env, request, body.request_id);
    // A new account gets a fresh offer. Keep the same-person fence if a workspace join already changed membership.
    const clearOffers = env.DB.prepare(`UPDATE auth_requests SET
        workspace_access=CASE WHEN json_extract(workspace_access,'$.user_id')=? THEN NULL ELSE workspace_access END,
        workspace_join=CASE WHEN json_extract(workspace_join,'$.user_id')=? AND json_type(workspace_join,'$.product') IS NOT NULL
            THEN NULL ELSE workspace_join END
        WHERE id=? AND browser_hash=? AND expires_at>? AND EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires_at>?)`);
    const now = Date.now();
    // Assert liveness in the same batch as logout, so an expired or concurrently answered request cannot sign out.
    const live = env.DB.prepare(`INSERT INTO admin_assertions(ok) VALUES (EXISTS (
        SELECT 1 FROM auth_requests r JOIN clients c ON c.id=r.client_id JOIN sessions s ON s.hash=?
        WHERE r.id=? AND r.browser_hash=? AND r.expires_at>? AND c.realm_id=? AND s.expires_at>?))`)
        .bind(session.hash, row.id, row.browser_hash, now, env.REALM.id, now);
    const responseCookies = await endIdentitySession(env, ctx, session,
        [live, clearOffers.bind(session.user_id, session.user_id, row.id, row.browser_hash, now, session.hash, now)])
        .catch(error => {
            invariant(!String(error.message).includes('admin_assertions'), 'invalid_request', 'This request was already answered or has expired.');
            throw error;
        });
    return redirect(signInAgainHref(row.id), responseCookies);
}
