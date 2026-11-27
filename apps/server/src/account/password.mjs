// Set, change or reset a password from a signed-in session. Reset arrives here from an email link with
// purpose 'password', which is fresh mailbox proof, so the current password is not asked for.
import { readBody, redirect, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE, issueSession } from '../auth/session.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { page } from '../pages/layout.mjs';
import { accountPage } from '../pages/shell.mjs';
import { heading, field, hidden, button, callout, actions } from '../pages/ui.mjs';
import { t } from '../i18n/index.mjs';
import { passwordStatus, requirePasswordEmail, savePassword } from './password-service.mjs';
import { appSignInBarred } from '../services/admission.mjs';
import { recordSignInRefusal } from '../auth/sign-in-refusals.mjs';
import { platformAddressPage } from '../pages/sign-in-refusal.mjs';

async function platformRefusal(env, pending, session) {
    if (!pending || !await appSignInBarred(env, session.email)) return null;
    await recordSignInRefusal(env, 'admin_address', { method: 'password', clientId: pending.client.id, email: session.email, audit: true });
    return platformAddressPage(env, pending);
}
function form(env, request, session, values, password, saved, pending) {
    const current = password.current_password_required
        ? field({ id: 'current_password', label: t(env, 'Current password'), type: 'password', name: 'current_password', autocomplete: 'current-password', required: true }) : '';
    const title = password.updated !== null ? t(env, 'Change password') : t(env, 'Set a password');
    const description = t(env, 'Use it to sign in to apps that offer passwords.');
    const body = `${saved ? callout(t(env, 'Password saved'), t(env, 'Your other sessions were signed out.'), { tone: 'success', role: 'status' }) : ''}
<form class="fd-form" method="post" action="/account/password">${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}${hidden('request_id', values.request_id || '')}
${current}${field({ id: 'password', label: t(env, 'New password'), type: 'password', name: 'password', autocomplete: 'new-password', minlength: 12, maxlength: 128, required: true, hint: t(env, '12 to 128 characters. A few unrelated words work well.') })}
${callout('', t(env, 'We check new passwords against known data breaches. Saving signs out your other sessions and forgets remembered browsers.'), { tone: 'info' })}
${values.request_id ? button(t(env, 'Save password'), { variant: 'primary', size: 'lg', block: true }) : actions(button(t(env, 'Save password'), { variant: 'primary' }))}</form>`;
    // Mid sign-in (an app is waiting) this is a centred screen; otherwise it sits in the account pages.
    return values.request_id ? page(title, heading(title, description) + body, { client: pending.client, formTargets: [pending.row.redirect_uri] })
        : accountPage(title, body, { env, session, active: 'security', description, back: [t(env, 'Security'), '/account/security'], normalBack: true });
}
export async function passwordPage(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return here.', 401);
    requirePasswordEmail(session);
    if (request.method === 'GET') {
        const query = uniqueParams(new URL(request.url).searchParams);
        const pending = query.request_id ? await pendingRequest(env, request, query.request_id) : null;
        const refused = await platformRefusal(env, pending, session);
        if (refused) return refused;
        return form(env, request, session, query, await passwordStatus(env, session), Boolean(query.done), pending);
    }
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    const pending = body.request_id ? await pendingRequest(env, request, body.request_id) : null;
    const refused = await platformRefusal(env, pending, session);
    if (refused) return refused;
    await savePassword(env, ctx, session, body);
    if (!pending) return redirect(`${env.ISSUER}/account/password?done=1`);
    // Continue to the app as a password sign-in: the person has just proved the mailbox and chosen the password.
    const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(session.user_id).first();
    const signed = await issueSession(env, user, 'password');
    const response = await completeAuthorization(env, request, pending.row.id, signed.session, signed.cookies);
    // Only once the new session has reached the app does the email-link session go.
    await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(session.hash).run();
    return response;
}
