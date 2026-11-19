import { tokenShape } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { cookies, cookie, CSRF_COOKIE, SESSION_COOKIE, BROWSER_COOKIE } from '../auth/session.mjs';
import { confirmedFactors, FRESH_MFA_MS, forgetDevices } from '../auth/mfa.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { limitEmail, attempt } from '../auth/rate-limit.mjs';
import { endAccess } from '../services/access.mjs';
import { dispatchDeliveries } from '../services/outbox.mjs';
import { notify } from '../services/notify.mjs';
import { sendEmail } from '../services/email/send.mjs';
import { audit } from '../services/audit.mjs';
import { userEventStatements } from '../services/user-events.mjs';
import { t, offeredBy, LANGUAGE_NAMES, useLocale } from '../i18n/index.mjs';

const FRESH_MS = 600000;
const freshMailbox = session => session.method === 'email' && freshSignIn(session);
const freshSignIn = session => session.auth_time * 1000 > Date.now() - FRESH_MS;
export const profileLanguages = env => offeredBy(env.REALM?.branding || {}).map(id => ({ id, label: LANGUAGE_NAMES[id] || id }));
export const readProfile = (env, session) => env.DB.prepare('SELECT email,display_name,email_verified,locale FROM users WHERE id=?')
    .bind(session.user_id).first();

export async function saveName(env, ctx, session, body) {
    const name = typeof body.display_name === 'string' ? body.display_name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim() : '';
    invariant(name.length <= 100, 'invalid_request', 'Use at most 100 characters.');
    const before = await env.DB.prepare('SELECT display_name FROM users WHERE id=?').bind(session.user_id).first();
    if ((before?.display_name || null) !== (name || null))
        await env.DB.batch([env.DB.prepare('UPDATE users SET display_name=? WHERE id=?').bind(name || null, session.user_id),
            ...userEventStatements(env, session.user_id, 'user-updated', { fields: ['name'] })]);
    ctx.waitUntil(dispatchDeliveries(env).catch(() => audit(env, 'event_dispatch_failed', null, { pending: true })));
    await audit(env, 'profile_updated', session.user_id, { fields: ['display_name'] });
}

export async function saveLanguage(env, session, body) {
    const locale = body.locale === '' ? null : body.locale;
    invariant(locale === null || (typeof locale === 'string' && offeredBy(env.REALM?.branding || {}).includes(locale)), 'invalid_request', 'Choose a language from the list.');
    await env.DB.prepare('UPDATE users SET locale=? WHERE id=?').bind(locale, session.user_id).run();
    useLocale(env, { user: locale });
}

// With a second factor on the account, changing the address needs it too: mailbox control alone must not move it.
export async function requireFreshFactor(env, session) {
    if ((await confirmedFactors(env, session.user_id)).length)
        invariant(session.mfa_at && session.mfa_at > Date.now() - FRESH_MFA_MS, 'mfa_required', 'Enter a second-factor code at /mfa?next=/account, then try again within 10 minutes.', 403);
}
export async function startEmailChange(request, env, ctx, session, body) {
    // Proof at both ends: a fresh email link for the current address now, and a link to the new one below.
    invariant(freshMailbox(session), 'reauth_required', 'Changing your email needs an email-link sign-in in the last 10 minutes. Sign in with a link, then try again.', 403);
    await requireFreshFactor(env, session);
    invariant(await attempt(env, 'email-change:' + session.user_id, 5), 'rate_limit', 'Too many email changes. Try again in 15 minutes.', 429);
    const email = normalizeEmail(body.new_email);
    invariant(email !== session.email.toLowerCase(), 'invalid_request', 'That’s already your email. Enter a different address.');
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(browser), 'browser_binding', 'Reload the account page and try again.', 403);
    invariant(env.EMAIL?.send && env.EMAIL_FROM, 'email_config', 'Email isn’t set up on this server, so the change can’t be confirmed. Contact the administrator.', 503);
    const message = { title: t(env, 'Confirmation link sent'), body: t(env, 'We sent a link to {email}. Open it in this browser within 15 minutes.', { email }) };
    // An address another account holds gets no email, and the answer is the same, so this reveals nothing.
    const held = await env.DB.prepare('SELECT 1 FROM users WHERE realm_id=? AND email=?').bind(env.REALM.id, email).first();
    if (held || !await limitEmail(env, email, request)) return message;
    const token = randomToken(), now = Date.now();
    await env.DB.batch([env.DB.prepare('DELETE FROM email_changes WHERE user_id=?').bind(session.user_id),
        env.DB.prepare('INSERT INTO email_changes(hash,user_id,new_email,browser_hash,expires_at) VALUES(?,?,?,?,?)').bind(await sha256(token), session.user_id, email, await sha256(browser), now + 900000)]);
    ctx.waitUntil(sendEmail(env, { kind: 'email_change_link', to: email, links: { link: `${env.ISSUER}/account/email/confirm?token=${token}` } })
        .catch(error => console.error(JSON.stringify({ type: 'email_change_failed', code: error?.code || 'send_failed' }))));
    notify(env, ctx, session.email, 'email_change_requested', { email });
    return message;
}
export async function deleteAccount(request, env, ctx, session, body) {
    invariant(typeof body.confirm_email === 'string' && body.confirm_email.trim().toLowerCase() === session.email.toLowerCase(), 'invalid_request', 'The email you typed doesn’t match this account. Type it exactly.');
    invariant(freshSignIn(session), 'reauth_required', 'Deleting your account needs a sign-in in the last 10 minutes. Sign in again, then try again.', 403);
    await requireFreshFactor(env, session);
    const id = session.user_id, now = Date.now();
    // Ends identity and app sessions (back-channel), agent grants (revocation events) and every sign-in method.
    // The deletion event goes first: the statements after it remove the admissions that address it.
    await env.DB.batch([env.DB.prepare("DELETE FROM user_event_outbox WHERE user_id=? AND delivered_at IS NULL AND event='user-updated'").bind(id),
        ...userEventStatements(env, id, 'user-deleted'), ...endAccess(env, id),
        env.DB.prepare('DELETE FROM user_identities WHERE user_id=?').bind(id), env.DB.prepare('DELETE FROM user_passwords WHERE user_id=?').bind(id),
        env.DB.prepare('DELETE FROM mfa_factors WHERE user_id=?').bind(id), env.DB.prepare('DELETE FROM recovery_codes WHERE user_id=?').bind(id),
        env.DB.prepare('DELETE FROM webauthn_credentials WHERE user_id=?').bind(id),
        forgetDevices(env, id), env.DB.prepare('DELETE FROM client_admissions WHERE user_id=?').bind(id),
        env.DB.prepare("UPDATE users SET status='deleted',display_name=NULL WHERE id=?").bind(id),
        env.DB.prepare("INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES('account_deleted',?,?,'{}',?,?)").bind(id, id, now, env.REALM.id)]);
    ctx.waitUntil(dispatchDeliveries(env).catch(() => audit(env, 'delete_dispatch_failed', null, { pending: true })));
    notify(env, ctx, session.email, 'account_deleted');
    return [cookie(SESSION_COOKIE, '', 0), cookie(CSRF_COOKIE, '', 0, false)];
}
