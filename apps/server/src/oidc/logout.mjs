import { logoutStatements, flushLogouts } from './backchannel.mjs';
import { getClient, registeredUri } from './clients.mjs';
import { getSession, requireCsrf, cookie, SESSION_COOKIE, CSRF_COOKIE, cookies } from '../auth/session.mjs';
import { uniqueParams, readBody, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { page, escapeHtml } from '../pages/layout.mjs';
import { audit } from '../services/audit.mjs';
import { logoutHint } from './logout-hint.mjs';
async function parameters(env, values, session) {
    if (values.id_token_hint) {
        const hint = await logoutHint(env, values.id_token_hint, session);
        invariant(!values.client_id || values.client_id === hint.aud, 'invalid_request', 'Logout client does not match hint.');
        values.client_id = hint.aud;
    }
    const client = await getClient(env, values.client_id);
    if (values.post_logout_redirect_uri) registeredUri(client, values.post_logout_redirect_uri, 'post_logout_uris');
    invariant(!values.state || values.state.length <= 512, 'invalid_request', 'State too long.');
    return values;
}
function destination(env, values) {
    if (!values.post_logout_redirect_uri) return env.ISSUER + '/signed-out';
    const url = new URL(values.post_logout_redirect_uri);
    if (values.state) url.searchParams.set('state', values.state);
    return url.href;
}
export async function logout(request, env, ctx) {
    const session = await getSession(request, env);
    const values = await parameters(env, request.method === 'GET' ? uniqueParams(new URL(request.url).searchParams) : await readBody(request, 'form'), session);
    if (request.method === 'GET') {
        if (!session) return redirect(destination(env, values));
        const fields = { client_id: values.client_id, post_logout_redirect_uri: values.post_logout_redirect_uri || '', state: values.state || '', id_token_hint: values.id_token_hint || '', csrf: cookies(request)[CSRF_COOKIE] || '' };
        return page('Sign out', `<h1>Sign out of ${escapeHtml(env.REALM.display_name)}?</h1><form method="post" action="/logout">${Object.entries(fields).map(([k,v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('')}<button>Sign out</button></form>`,
            { formTargets: values.post_logout_redirect_uri ? [values.post_logout_redirect_uri] : [] });
    }
    await requireCsrf(request, env, session, values.csrf);
    await env.DB.batch([...logoutStatements(env, session.user_id, session.sid),
        env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(session.hash),
        env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES('sign_out',?,?,?,?)")
            .bind(session.user_id, JSON.stringify({ sid: session.sid }), Date.now(), env.REALM.id)]);
    ctx.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
    return redirect(destination(env, values), [cookie(SESSION_COOKIE, '', 0), cookie(CSRF_COOKIE, '', 0, false)]);
}
