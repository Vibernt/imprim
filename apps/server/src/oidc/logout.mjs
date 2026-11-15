import { logoutStatements, flushLogouts } from './backchannel.mjs';
import { getClient, registeredUri } from './clients.mjs';
import { getSession, requireCsrf, cookie, SESSION_COOKIE, CSRF_COOKIE, cookies } from '../auth/session.mjs';
import { uniqueParams, readBody, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { page } from '../pages/layout.mjs';
import { result, hidden, button, linkButton } from '../pages/ui.mjs';
import { audit } from '../services/audit.mjs';
import { logoutHint } from './logout-hint.mjs';
async function parameters(env, values, session) {
    if (values.id_token_hint) {
        const hint = await logoutHint(env, values.id_token_hint, session);
        invariant(!values.client_id || values.client_id === hint.aud, 'invalid_request', 'Logout client does not match hint.');
        values.client_id = hint.aud;
    }
    // Signing out from Imprim's own pages (the console, the account) names no app. Nothing can be carried then, so no
    // outside address is ever reached: the person lands on /signed-out.
    if (!values.client_id) {
        invariant(!values.post_logout_redirect_uri && !values.state, 'invalid_request', 'A return address needs the app’s client_id.');
        return values;
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
        const fields = { client_id: values.client_id || '', post_logout_redirect_uri: values.post_logout_redirect_uri || '', state: values.state || '', id_token_hint: values.id_token_hint || '', csrf: cookies(request)[CSRF_COOKIE] || '' };
        return page('Sign out', result('log-out', 'neutral', `Sign out of ${env.REALM.display_name}?`, 'This ends your session in this browser.') +
            `<form method="post" action="/logout">${Object.entries(fields).map(([k, v]) => hidden(k, v)).join('')}${button('Sign out', { variant: 'primary', size: 'lg', block: true })}</form>` +
            (values.client_id ? '' : linkButton('Stay signed in', '/account', { variant: 'ghost', size: 'lg', block: true })),
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
