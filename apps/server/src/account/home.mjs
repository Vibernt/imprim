// /account: one page for everything a person controls. Profile, security, sessions, connected apps and agents,
// email change and deletion. Every change is a CSRF-checked POST; sensitive ones need fresh proof.
import { readBody, redirect, uniqueParams, tokenShape } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { getSession, requireCsrf, cookies, cookie, CSRF_COOKIE, SESSION_COOKIE, BROWSER_COOKIE } from '../auth/session.mjs';
import { confirmedFactors, FRESH_MFA_MS, forgetDevices } from '../auth/mfa.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { limitEmail, attempt } from '../auth/rate-limit.mjs';
import { appSessionLifetimeMs } from '../oidc/app-sessions.mjs';
import { endAccess } from '../services/access.mjs';
import { logoutStatements, flushLogouts } from '../oidc/backchannel.mjs';
import { dispatchDeliveries } from '../services/outbox.mjs';
import { agentsSection } from '../agents/account.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { heading, button, linkButton, field, hidden, callout, setting, kv, badge, status, empty, actions, small } from '../pages/ui.mjs';
import { notify } from '../services/notify.mjs';
import { audit } from '../services/audit.mjs';
import { userEventStatements } from '../services/user-events.mjs';
const FRESH_MS = 600000;
const csrfField = request => hidden('csrf', cookies(request)[CSRF_COOKIE] || '');
// A one-button form for a row action; `options` go to button() (an aria-label names the row for screen readers).
export const rowAction = (request, path, fields, label, options = {}) =>
    `<form method="post" action="${path}">${csrfField(request)}${fields}${button(label, { variant: 'outline', size: 'sm', ...options })}</form>`;
// Short UTC dates ("Nov 15, 2026 4:29 PM"); the sessions section says once that times are UTC.
const DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
export const when = value => value ? `${DAY.format(value)} ${TIME.format(value)}` : 'Never';
export const day = value => value ? DAY.format(value) : 'Never';
const METHODS = { email: 'an email link', password: 'a password', passkey: 'a passkey', github: 'GitHub', google: 'Google' };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// A section of the account page; the h2 keeps its id so /account#sessions and the like still land.
export const accountSection = (id, title, description, body) => `<section class="fd-stack" data-gap="3"><div class="fd-stack" data-gap="1"><h2 class="fd-h3" id="${id}">${e(title)}</h2>${description ? `<p class="fd-small fd-muted">${e(description)}</p>` : ''}</div>${body}</section>`;
// A Fire list whose trail can hold a form (a div, so the form is not inside a span). title is text; the rest is safe markup.
const rowList = (label, rows) => `<ul class="fd-list" data-card aria-label="${e(label)}">${rows.map(row => `<li class="fd-list-row"><div class="fd-list-body"><span class="fd-list-title">${e(row.title)}</span>${row.desc ? `<span class="fd-list-desc">${row.desc}</span>` : ''}</div>${row.meta ? `<span class="fd-list-meta">${row.meta}</span>` : ''}${row.trail ? `<div class="fd-list-trail">${row.trail}</div>` : ''}</li>`).join('')}</ul>`;
// A labelled input with its button beside it, in a settings row. `input` is already-safe markup.
const inlineForm = (request, path, { id, label, desc, input, submit }) => `<form method="post" action="${path}">${csrfField(request)}<div class="fd-form-row" data-layout="stack">
<div class="fd-form-row-text"><label class="fd-form-row-label" for="${id}">${e(label)}</label>${desc ? `<span class="fd-form-row-desc" id="${id}-desc">${e(desc)}</span>` : ''}</div>
<div class="fd-form-row-control"><div class="fd-field"><div class="fd-input-pair">${input}${submit}</div></div></div></div></form>`;
// An email link within ten minutes proves the current mailbox.
const freshMailbox = session => session.method === 'email' && session.auth_time * 1000 > Date.now() - FRESH_MS;
const freshSignIn = session => session.auth_time * 1000 > Date.now() - FRESH_MS;
async function requireSession(request, env) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return to your account.', 401);
    return session;
}
// message: what is now true, as a string or { title, body }.
export async function accountHome(request, env, session, message = '') {
    const user = await env.DB.prepare('SELECT email,display_name,email_verified FROM users WHERE id=?').bind(session.user_id).first();
    const [password, factors, sessions, apps, devices] = await Promise.all([
        env.DB.prepare('SELECT updated FROM user_passwords WHERE user_id=?').bind(session.user_id).first(),
        confirmedFactors(env, session.user_id),
        env.DB.prepare('SELECT sid,method,auth_time,last_seen,device,location FROM sessions WHERE user_id=? AND expires_at>? ORDER BY auth_time DESC LIMIT 50').bind(session.user_id, Date.now()).all(),
        env.DB.prepare(`SELECT a.client_id,c.branding,max(a.created) AS signed_in FROM app_sessions a JOIN clients c ON c.id=a.client_id
            WHERE a.user_id=? GROUP BY a.client_id ORDER BY signed_in DESC LIMIT 50`).bind(session.user_id).all(),
        env.DB.prepare('SELECT hash,name,created,last_used,expires_at FROM trusted_devices WHERE user_id=? AND expires_at>? ORDER BY last_used DESC').bind(session.user_id, Date.now()).all()
    ]);
    if (!message && new URL(request.url).searchParams.get('changed') === 'email') message = { title: 'Email changed', body: 'Sign in with your new address from now on.' };
    const note = message ? callout(message.title ?? message, message.body ?? '', { tone: 'success', role: 'status' }) : '';
    const sessionRows = sessions.results.map(s => {
        const device = s.device || 'Unknown device', current = s.sid === session.sid;
        return { title: device, desc: e([s.location, `Signed in ${when(s.auth_time * 1000)} with ${METHODS[s.method] || s.method}`].filter(Boolean).join(' · ')),
            meta: e(`Active ${when(s.last_seen)}`),
            trail: current ? badge('This browser', 'success') : rowAction(request, '/account/sessions', hidden('sid', s.sid), 'Sign out', { 'aria-label': `Sign out ${device}` }) };
    });
    const appRows = apps.results.map(a => {
        const name = JSON.parse(a.branding).name || a.client_id;
        return { title: name, desc: e(`Signed in ${when(a.signed_in)}`),
            trail: rowAction(request, '/account/apps', hidden('client_id', a.client_id), 'Sign out', { 'aria-label': `Sign out of ${name}` }) };
    });
    const deviceRows = devices.results.map(d => ({ title: d.name, desc: e(`Remembered until ${day(d.expires_at)}`),
        trail: rowAction(request, '/account/devices', hidden('device', d.hash), 'Forget', { 'aria-label': `Forget ${d.name}` }) }));
    const apps2fa = factors.filter(f => f.type !== 'passkey').length, passkeys = factors.length - apps2fa;
    const factorText = factors.length ? `${status('On', 'success')} ${e([apps2fa && plural(apps2fa, 'authenticator app'), passkeys && plural(passkeys, 'passkey')].filter(Boolean).join(' · '))}`
        : `${status('Off')} ${e('Ask for a code or passkey when you sign in.')}`;
    const profile = accountSection('profile', 'Profile', '', `<div>
${setting('Email', `<span class="fd-mono">${e(user.email)}</span>${user.email_verified ? '' : ` ${badge('Not confirmed', 'warning')} ${e('Sign in with an email link to confirm it.')}`}`)}
${inlineForm(request, '/account/profile', { id: 'display_name', label: 'Name', desc: 'Apps that ask for your profile see this name.',
        input: `<input class="fd-input" id="display_name" name="display_name" maxlength="100" autocomplete="name" aria-describedby="display_name-desc" value="${e(user.display_name || '')}">`, submit: button('Save name') })}
${inlineForm(request, '/account/email', { id: 'new_email', label: 'New email', desc: 'Needs an email-link sign-in in the last 10 minutes. We confirm the new address and tell the old one.',
        input: '<input class="fd-input" id="new_email" name="new_email" type="email" maxlength="254" autocomplete="email" placeholder="name@example.com" aria-describedby="new_email-desc" required>', submit: button('Change email') })}
</div>`);
    const security = accountSection('security', 'Security', '', `<div>
${setting('Password', password ? e(`Set ${day(password.updated)}`) : e('None. Apps that offer passwords let you set one.'), password ? linkButton('Change password', '/account/password', { variant: 'outline' }) : '')}
${setting('Two-factor authentication', factorText, linkButton(factors.length ? 'Manage' : 'Set up', '/account/mfa', { variant: 'outline' }))}
<div class="fd-setting" data-align="start"><div class="fd-setting-text"><h3 class="fd-setting-title">Remembered browsers</h3><p class="fd-setting-desc">These skip the second-factor code until the date shown.</p></div>
${deviceRows.length ? rowList('Remembered browsers', deviceRows) : empty('No remembered browsers', 'Browsers you choose to remember at a second-factor prompt appear here.')}</div>
</div>`);
    const signedIn = accountSection('sessions', 'Signed-in sessions', 'Browsers signed in to your account. Times are UTC.', rowList('Signed-in sessions', sessionRows) +
        (sessions.results.length > 1 ? actions(rowAction(request, '/account/sessions', hidden('sid', 'others'), 'Sign out other sessions', { size: undefined })) : ''));
    const appList = accountSection('apps', 'Apps', 'Signing out of an app ends its session on every device.', appRows.length ? rowList('Apps', appRows)
        : empty('No apps yet', 'Apps you sign in to with this account appear here.'));
    const remove = accountSection('delete', 'Delete account', 'Signs you out of every app and agent and removes how you sign in. It can’t be undone.',
        `<form class="fd-form" method="post" action="/account/delete">${csrfField(request)}
${field({ id: 'confirm_email', name: 'confirm_email', label: 'Your email', hint: `Type ${user.email} to confirm.`, autocomplete: 'off', spellcheck: 'false', required: true })}
${small('Apps keep their own records of you. Deleting needs a sign-in in the last 10 minutes.')}
${actions(button('Delete account', { variant: 'danger' }))}</form>`);
    return page('Your account', `${heading('Your account', 'Manage your profile, sign-in security and where you’re signed in.')}${note}
${profile}
${security}
${signedIn}
${appList}
${await agentsSection(request, env, session)}
${remove}`, { wide: true });
}
export async function accountAction(request, env, ctx) {
    const session = await requireSession(request, env);
    const url = new URL(request.url), what = url.pathname.slice('/account/'.length);
    if (request.method === 'GET' && what === 'email/confirm') return confirmEmailPage(request, env, session);
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    const now = Date.now();
    if (what === 'profile') {
        const name = typeof body.display_name === 'string' ? body.display_name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim() : '';
        invariant(name.length <= 100, 'invalid_request', 'Use at most 100 characters.');
        const before = await env.DB.prepare('SELECT display_name FROM users WHERE id=?').bind(session.user_id).first();
        if ((before?.display_name || null) !== (name || null))
            await env.DB.batch([env.DB.prepare('UPDATE users SET display_name=? WHERE id=?').bind(name || null, session.user_id),
                ...userEventStatements(env, session.user_id, 'user-updated', { fields: ['name'] })]);
        ctx.waitUntil(dispatchDeliveries(env).catch(() => audit(env, 'event_dispatch_failed', null, { pending: true })));
        await audit(env, 'profile_updated', session.user_id, { fields: ['display_name'] });
        return accountHome(request, env, session, 'Name saved');
    }
    if (what === 'sessions') {
        invariant(typeof body.sid === 'string' && body.sid.length > 0 && body.sid.length <= 64, 'invalid_request', 'Choose a session to sign out.');
        const others = body.sid === 'others';
        invariant(others || body.sid !== session.sid, 'invalid_request', 'This is the browser you’re using. Sign out from your app to end it.');
        await env.DB.batch([...(others ? logoutStatements(env, session.user_id, null, session.sid) : logoutStatements(env, session.user_id, body.sid)),
            others ? env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND sid<>?').bind(session.user_id, session.sid)
                : env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND sid=?').bind(session.user_id, body.sid)]);
        ctx.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
        await audit(env, 'sessions_revoked', session.user_id, { scope: others ? 'others' : 'one' });
        return accountHome(request, env, session, others ? 'Signed out of other sessions' : 'Session signed out');
    }
    if (what === 'apps') {
        invariant(typeof body.client_id === 'string' && body.client_id.length <= 200, 'invalid_request', 'Choose an app to sign out of.');
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created) SELECT lower(hex(randomblob(16))),a.client_id,a.user_id,NULL,c.backchannel_uri,?
                FROM app_sessions a JOIN clients c ON c.id=a.client_id WHERE a.user_id=? AND a.client_id=? AND a.created>? GROUP BY a.client_id`).bind(now, session.user_id, body.client_id, now - appSessionLifetimeMs),
            env.DB.prepare('DELETE FROM app_sessions WHERE user_id=? AND client_id=?').bind(session.user_id, body.client_id)]);
        ctx.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
        await audit(env, 'app_signed_out', session.user_id, { client_id: body.client_id });
        return accountHome(request, env, session, 'Signed out of the app');
    }
    if (what === 'devices') {
        invariant(typeof body.device === 'string' && /^[0-9a-f]{64}$/.test(body.device), 'invalid_request', 'Choose a browser to forget.');
        await env.DB.prepare('DELETE FROM trusted_devices WHERE hash=? AND user_id=?').bind(body.device, session.user_id).run();
        return accountHome(request, env, session, 'Browser forgotten');
    }
    if (what === 'email') return startEmailChange(request, env, ctx, session, body);
    if (what === 'email/confirm') return confirmEmailChange(request, env, ctx, session, body);
    if (what === 'delete') return deleteAccount(request, env, ctx, session, body);
    invariant(false, 'not_found', 'Unknown account action.', 404);
}
// With a second factor on the account, changing the address needs it too: mailbox control alone must not move it.
async function requireFreshFactor(env, session) {
    if ((await confirmedFactors(env, session.user_id)).length)
        invariant(session.mfa_at && session.mfa_at > Date.now() - FRESH_MFA_MS, 'mfa_required', 'Enter a second-factor code at /mfa?next=/account, then try again within 10 minutes.', 403);
}
async function startEmailChange(request, env, ctx, session, body) {
    // Proof at both ends: a fresh email link for the current address now, and a link to the new one below.
    invariant(freshMailbox(session), 'reauth_required', 'Changing your email needs an email-link sign-in in the last 10 minutes. Sign in with a link, then try again.', 403);
    await requireFreshFactor(env, session);
    invariant(await attempt(env, 'email-change:' + session.user_id, 5), 'rate_limit', 'Too many email changes. Try again in 15 minutes.', 429);
    const email = normalizeEmail(body.new_email);
    invariant(email !== session.email.toLowerCase(), 'invalid_request', 'That’s already your email. Enter a different address.');
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(browser), 'browser_binding', 'Reload the account page and try again.', 403);
    invariant(env.EMAIL?.send && env.EMAIL_FROM, 'email_config', 'Email isn’t set up on this server, so the change can’t be confirmed. Contact the administrator.', 503);
    const message = { title: 'Confirmation link sent', body: `We sent a link to ${email}. Open it in this browser within 15 minutes.` };
    // An address another account holds gets no email, and the answer is the same, so this reveals nothing.
    const held = await env.DB.prepare('SELECT 1 FROM users WHERE realm_id=? AND email=?').bind(env.REALM.id, email).first();
    if (held || !await limitEmail(env, email, request)) return accountHome(request, env, session, message);
    const token = randomToken(), now = Date.now();
    await env.DB.batch([env.DB.prepare('DELETE FROM email_changes WHERE user_id=?').bind(session.user_id),
        env.DB.prepare('INSERT INTO email_changes(hash,user_id,new_email,browser_hash,expires_at) VALUES(?,?,?,?,?)').bind(await sha256(token), session.user_id, email, await sha256(browser), now + 900000)]);
    ctx.waitUntil(env.EMAIL.send({ from: env.EMAIL_FROM, to: email, subject: `${env.REALM.display_name}: confirm your new email`,
        text: `Open this link in the browser where you asked for the change, then choose Confirm. It expires in 15 minutes.\n\n${env.ISSUER}/account/email/confirm?token=${token}\n\nIgnore this email if you did not ask for it.` })
        .catch(error => console.error(JSON.stringify({ type: 'email_change_failed', code: error?.code || 'send_failed' }))));
    notify(env, ctx, session.email, 'email change requested', `Someone signed in to your account asked to change its email to ${email}. Nothing changes until that address is confirmed.`);
    return accountHome(request, env, session, message);
}
// GET shows a confirm button; only the POST changes anything, so link scanners cannot.
async function confirmEmailPage(request, env, session) {
    const token = uniqueParams(new URL(request.url).searchParams).token;
    invariant(tokenShape(token), 'invalid_request', 'This confirmation link is incomplete. Open the link from the email again.');
    const row = await env.DB.prepare('SELECT new_email FROM email_changes WHERE hash=? AND user_id=? AND expires_at>?').bind(await sha256(token), session.user_id, Date.now()).first();
    invariant(row, 'invalid_grant', 'This link expired, was used, or belongs to another account.', 400);
    return page('Confirm new email', `${heading('Confirm new email', 'Your account will use the new address from now on.')}
${kv([['Current email', `<span class="fd-mono">${e(session.email)}</span>`], ['New email', `<strong class="fd-mono">${e(row.new_email)}</strong>`]], 1)}
<form class="fd-stack" data-gap="3" method="post" action="/account/email/confirm">${csrfField(request)}${hidden('token', token)}${button('Change email', { variant: 'primary', block: true })}</form>`);
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
    notify(env, ctx, old, 'your email was changed', `Your account's email changed from ${old} to ${row.new_email}. If you did not do this, contact the app you use.`);
    return redirect(`${env.ISSUER}/account?changed=email`);
}
async function deleteAccount(request, env, ctx, session, body) {
    invariant(typeof body.confirm_email === 'string' && body.confirm_email.trim().toLowerCase() === session.email.toLowerCase(), 'invalid_request', 'The email you typed doesn’t match this account. Type it exactly.');
    invariant(freshSignIn(session), 'reauth_required', 'Deleting your account needs a sign-in in the last 10 minutes. Sign in again, then try again.', 403);
    if ((await confirmedFactors(env, session.user_id)).length)
        invariant(session.mfa_at && session.mfa_at > Date.now() - FRESH_MFA_MS, 'mfa_required', 'Enter a second-factor code at /mfa?next=/account, then try again within 10 minutes.', 403);
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
    notify(env, ctx, session.email, 'your account was deleted', 'Your account was deleted and you were signed out everywhere.');
    return redirect(`${env.ISSUER}/signed-out`, [cookie(SESSION_COOKIE, '', 0), cookie(CSRF_COOKIE, '', 0, false)]);
}
