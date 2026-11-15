// Set, change or reset a password from a signed-in session. Reset arrives here from an email link with
// purpose 'password', which is fresh mailbox proof, so the current password is not asked for.
import { readBody, redirect, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE, issueSession, cookie, SESSION_COOKIE } from '../auth/session.mjs';
import { validatePassword } from '../auth/password-policy.mjs';
import { assertNotBreached } from '../auth/breach.mjs';
import { hashPassword, verifyPassword } from '../auth/password-hash.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { page } from '../pages/layout.mjs';
import { heading, field, hidden, button, linkButton, callout, small } from '../pages/ui.mjs';
import { audit } from '../services/audit.mjs';
import { notify } from '../services/notify.mjs';
import { logoutStatements, flushLogouts } from '../oidc/backchannel.mjs';
import { forgetDevices } from '../auth/mfa.mjs';
export const FRESH_MS = 600000;
const freshMailbox = session => session.method === 'email' && session.auth_time * 1000 > Date.now() - FRESH_MS;
function form(request, session, values, hasPassword, saved = false) {
    const current = hasPassword && !freshMailbox(session)
        ? field({ id: 'current_password', label: 'Current password', type: 'password', name: 'current_password', autocomplete: 'current-password', required: true }) : '';
    const title = hasPassword ? 'Change password' : 'Set a password';
    return page(title, `${heading(title, 'Use it to sign in to apps that offer passwords.')}
${saved ? callout('Password saved', 'Your other sessions were signed out.', { tone: 'success', role: 'status' }) : ''}
<form class="fd-stack" data-gap="4" method="post" action="/account/password">${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}${hidden('request_id', values.request_id || '')}
${current}${field({ id: 'password', label: 'New password', type: 'password', name: 'password', autocomplete: 'new-password', minlength: 12, maxlength: 128, required: true, hint: '12 to 128 characters. A few unrelated words work well.' })}
${small('We check new passwords against known data breaches. Saving signs out your other sessions and forgets remembered browsers.')}
${button('Save password', { variant: 'primary', block: true })}</form>
${values.request_id ? '' : `<div class="fd-row" data-justify="center">${linkButton('Back to your account', '/account', { variant: 'ghost' })}</div>`}`);
}
export async function passwordPage(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return here.', 401);
    invariant(session.email_verified === 1, 'access_denied', 'Your email isn’t confirmed yet. Sign in with an email link, then set a password.', 403);
    const stored = await env.DB.prepare('SELECT * FROM user_passwords WHERE user_id=?').bind(session.user_id).first();
    if (request.method === 'GET') {
        const query = uniqueParams(new URL(request.url).searchParams);
        return form(request, session, query, Boolean(stored), Boolean(query.done));
    }
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    const pending = body.request_id ? await pendingRequest(env, request, body.request_id) : null;
    // A first password needs fresh mailbox proof (an email link in the last ten minutes); a change needs that or the
    // current password.
    if (!stored) invariant(freshMailbox(session), 'reauth_required', 'Setting a first password needs an email-link sign-in in the last 10 minutes. Use Set or reset password at sign-in.', 403);
    else if (!freshMailbox(session))
        invariant(typeof body.current_password === 'string' && await verifyPassword(body.current_password, stored), 'invalid_grant', 'That isn’t your current password. Try again, or reset it from the sign-in page.', 403);
    validatePassword(body.password, session.email);
    await assertNotBreached(body.password);
    const next = await hashPassword(body.password), now = Date.now();
    // One transaction: the new hash, the end of every other session (a reset must lock out whoever else is signed
    // in), and the audit record.
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO user_passwords(user_id,algorithm,iterations,salt,hash,created,updated) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET algorithm=excluded.algorithm,iterations=excluded.iterations,salt=excluded.salt,hash=excluded.hash,updated=excluded.updated`)
            .bind(session.user_id, next.algorithm, next.iterations, next.salt, next.hash, now, now),
        // Everyone else signed in as this person is signed out of identity and, by back-channel, of every app.
        ...logoutStatements(env, session.user_id, null, session.sid),
        env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND hash<>?').bind(session.user_id, session.hash),
        forgetDevices(env, session.user_id),
        env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,'{}',?,?)").bind(stored ? 'password_changed' : 'password_set', session.user_id, now, env.REALM.id)
    ]);
    ctx?.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
    notify(env, ctx, session.email, stored ? 'your password was changed' : 'a password was set on your account',
        `${stored ? 'Your password was changed' : 'A password was set for your account'} on ${new Date(now).toUTCString()}. Other signed-in sessions were signed out.`);
    if (!pending) return redirect(`${env.ISSUER}/account/password?done=1`);
    // Continue to the app as a password sign-in: the person has just proved the mailbox and chosen the password.
    const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(session.user_id).first();
    const signed = await issueSession(env, user, 'password');
    const response = await completeAuthorization(env, request, pending.row.id, signed.session, signed.cookies);
    // Only once the new session has reached the app does the email-link session go.
    await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(session.hash).run();
    return response;
}
