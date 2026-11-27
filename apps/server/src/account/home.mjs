// Retained account form actions and the browser-bound email confirmation page.
import { readBody, redirect, uniqueParams, tokenShape } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { sha256 } from '../lib/crypto.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE, BROWSER_COOKIE } from '../auth/session.mjs';
import { dispatchDeliveries } from '../services/outbox.mjs';
import { endSessions, endAppSessions, forgetBrowser } from './sessions.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { accountPage } from '../pages/shell.mjs';
import { heading, button, field, hidden, callout, setting, kv, badge, actions, small } from '../pages/ui.mjs';
import { notify } from '../services/notify.mjs';
import { audit } from '../services/audit.mjs';
import { userEventStatements } from '../services/user-events.mjs';
import { t } from '../i18n/index.mjs';
import { readProfile, profileLanguages, saveName, saveLanguage, startEmailChange, requireFreshFactor, deleteAccount } from './profile.mjs';
const csrfField = request => hidden('csrf', cookies(request)[CSRF_COOKIE] || '');
// A titled section of an account page.
const accountSection = (id, title, description, body) => `<section class="fd-stack" data-gap="3"><div class="fd-stack" data-gap="1"><h2 class="fd-h3" id="${id}">${e(title)}</h2>${description ? `<p class="fd-small fd-muted">${e(description)}</p>` : ''}</div>${body}</section>`;
// A labelled input with its button beside it, in a settings row. `input` is already-safe markup.
const inlineForm = (request, path, { id, label, desc, input, submit }) => `<form method="post" action="${path}">${csrfField(request)}<div class="fd-form-row" data-layout="stack">
<div class="fd-form-row-text"><label class="fd-form-row-label" for="${id}">${e(label)}</label>${desc ? `<span class="fd-form-row-desc" id="${id}-desc">${e(desc)}</span>` : ''}</div>
<div class="fd-form-row-control"><div class="fd-field"><div class="fd-input-pair">${input}${submit}</div></div></div></div></form>`;
// The person's language: Automatic (the browser's, then the brand's) or one the realm offers. Names are each language's own.
function languageForm(request, env, current) {
    const options = [['', t(env, 'Automatic')], ...profileLanguages(env).map(({ id, label }) => [id, label])];
    const select = `<select class="fd-select" id="locale" name="locale" aria-describedby="locale-desc">${options.map(([value, label]) =>
        `<option value="${e(value)}"${value ? ` lang="${e(value)}"` : ''}${(current || '') === value ? ' selected' : ''}>${e(label)}</option>`).join('')}</select>`;
    return inlineForm(request, '/account/language', { id: 'locale', label: t(env, 'Language'), desc: t(env, 'For these pages and the emails we send you.'), input: select, submit: button(t(env, 'Save language')) });
}
async function requireSession(request, env) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return to your account.', 401);
    return session;
}
// The retained profile form actions still return their profile view.
async function accountHome(request, env, session, message) {
    const note = callout(message.title ?? message, message.body ?? '', { tone: 'success', role: 'status' });
    const { title, description, bands } = await profile(request, env, session);
    return accountPage(title, [note + bands[0], ...bands.slice(1)], { env, session, active: 'profile', description });
}
async function profile(request, env, session) {
    const user = await readProfile(env, session);
    const settings = `<div>
${setting(t(env, 'Email'), `<span class="fd-mono">${e(user.email)}</span>${user.email_verified ? '' : ` ${badge(t(env, 'Not confirmed'), 'warning')} ${e(t(env, 'Sign in with an email link to confirm it.'))}`}`)}
${inlineForm(request, '/account/profile', { id: 'display_name', label: t(env, 'Name'), desc: t(env, 'Apps that ask for your profile see this name.'),
        input: `<input class="fd-input" id="display_name" name="display_name" maxlength="100" autocomplete="name" aria-describedby="display_name-desc" value="${e(user.display_name || '')}">`, submit: button(t(env, 'Save name')) })}
${languageForm(request, env, user.locale)}
${inlineForm(request, '/account/email', { id: 'new_email', label: t(env, 'New email'), desc: t(env, 'Needs an email-link sign-in in the last 10 minutes. We confirm the new address and tell the old one.'),
        input: `<input class="fd-input" id="new_email" name="new_email" type="email" maxlength="254" autocomplete="email" placeholder="${e(t(env, 'name@example.com'))}" aria-describedby="new_email-desc" required>`, submit: button(t(env, 'Change email')) })}
</div>`;
    const remove = accountSection('delete', t(env, 'Delete account'), t(env, 'Signs you out of every app and agent and removes how you sign in. It can’t be undone.'),
        `<form class="fd-form" method="post" action="/account/delete">${csrfField(request)}
${field({ id: 'confirm_email', name: 'confirm_email', label: t(env, 'Your email'), hint: t(env, 'Type {email} to confirm.', { email: user.email }), autocomplete: 'off', spellcheck: 'false', required: true })}
${small(t(env, 'Apps keep their own records of you. Deleting needs a sign-in in the last 10 minutes.'))}
${actions(button(t(env, 'Delete account'), { variant: 'danger' }))}</form>`);
    return { title: t(env, 'Profile'), description: t(env, 'Your name and email, as the apps you sign in to see them.'), bands: [settings, remove] };
}
export async function accountAction(request, env, ctx) {
    const session = await requireSession(request, env);
    const url = new URL(request.url), what = url.pathname.slice('/account/'.length);
    if (request.method === 'GET' && what === 'email/confirm') return confirmEmailPage(request, env, session);
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    if (what === 'profile') {
        await saveName(env, ctx, session, body);
        return accountHome(request, env, session, t(env, 'Name saved'));
    }
    if (what === 'language') {
        await saveLanguage(env, session, body);
        return accountHome(request, env, session, t(env, 'Language saved'));
    }
    if (what === 'sessions') await endSessions(env, ctx, session, body);
    if (what === 'apps') await endAppSessions(env, ctx, session, body);
    if (what === 'devices') await forgetBrowser(env, session, body);
    const changed = { sessions: body.sid === 'others' ? 'others' : 'session', apps: 'app', devices: 'browser' }[what];
    if (changed) return redirect(`${env.ISSUER}/account/sessions?changed=${changed}`);
    if (what === 'email') return accountHome(request, env, session, await startEmailChange(request, env, ctx, session, body));
    if (what === 'email/confirm') return confirmEmailChange(request, env, ctx, session, body);
    if (what === 'delete') return redirect(`${env.ISSUER}/signed-out`, await deleteAccount(request, env, ctx, session, body));
    invariant(false, 'not_found', 'Unknown account action.', 404);
}
// GET shows a confirm button; only the POST changes anything, so link scanners cannot.
async function confirmEmailPage(request, env, session) {
    const token = uniqueParams(new URL(request.url).searchParams).token;
    invariant(tokenShape(token), 'invalid_request', 'This confirmation link is incomplete. Open the link from the email again.');
    const row = await env.DB.prepare('SELECT new_email FROM email_changes WHERE hash=? AND user_id=? AND expires_at>?').bind(await sha256(token), session.user_id, Date.now()).first();
    invariant(row, 'invalid_grant', 'This link expired, was used, or belongs to another account.', 400);
    return page(t(env, 'Confirm new email'), `${heading(t(env, 'Confirm new email'), t(env, 'Your account will use the new address from now on.'))}
${kv([[t(env, 'Current email'), `<span class="fd-mono">${e(session.email)}</span>`], [t(env, 'New email'), `<strong class="fd-mono">${e(row.new_email)}</strong>`]], 1)}
<form class="fd-stack" data-gap="3" method="post" action="/account/email/confirm">${csrfField(request)}${hidden('token', token)}${button(t(env, 'Change email'), { variant: 'primary', block: true })}</form>`);
}
async function confirmEmailChange(request, env, ctx, session, body) {
    invariant(tokenShape(body.token) && tokenShape(cookies(request)[BROWSER_COOKIE]), 'invalid_grant', 'This confirmation link is incomplete. Open the link from the email again.', 400);
    await requireFreshFactor(env, session);
    const row = await env.DB.prepare('DELETE FROM email_changes WHERE hash=? AND user_id=? AND browser_hash=? AND expires_at>? RETURNING *')
        .bind(await sha256(body.token), session.user_id, await sha256(cookies(request)[BROWSER_COOKIE]), Date.now()).first();
    invariant(row, 'invalid_grant', 'This link expired, was used, or belongs to another account or browser.', 400);
    const old = session.email;
    try {
        await env.DB.batch([env.DB.prepare('UPDATE users SET email=?,email_verified=1 WHERE id=?').bind(row.new_email, session.user_id),
            ...userEventStatements(env, session.user_id, 'user-updated', { fields: ['email'] }),
            env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES('email_changed',?,'{}',?,?)").bind(session.user_id, Date.now(), env.REALM.id)]);
    } catch (error) {
        invariant(!String(error.message).includes('UNIQUE'), 'conflict', 'That address belongs to another account. Use a different one.', 409);
        throw error;
    }
    ctx.waitUntil(dispatchDeliveries(env).catch(() => audit(env, 'event_dispatch_failed', null, { pending: true })));
    notify(env, ctx, old, 'email_changed', { old, new: row.new_email });
    return redirect(`${env.ISSUER}/account?changed=email`);
}
