// /account: one page for everything a person controls. Profile, security, sessions, connected apps and agents,
// email change and deletion. Every change is a CSRF-checked POST; sensitive ones need fresh proof.
import { readBody, redirect, uniqueParams, tokenShape } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { getSession, requireCsrf, cookies, cookie, CSRF_COOKIE, SESSION_COOKIE, BROWSER_COOKIE } from '../auth/session.mjs';
import { confirmedFactors, FRESH_MFA_MS, forgetDevices } from '../auth/mfa.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { endAccess } from '../services/access.mjs';
import { logoutStatements, flushLogouts } from '../oidc/backchannel.mjs';
import { dispatchDeliveries } from '../services/outbox.mjs';
import { agentsSection } from '../agents/account.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { notify } from '../services/notify.mjs';
import { audit } from '../services/audit.mjs';
const FRESH_MS = 600000;
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${e(value ?? '')}">`;
const action = (request, path, fields, label) => `<form method="post" action="${path}">${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}${fields}<button>${e(label)}</button></form>`;
const when = value => value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never';
// An email link within ten minutes proves the current mailbox.
const freshMailbox = session => session.method === 'email' && session.auth_time * 1000 > Date.now() - FRESH_MS;
const freshSignIn = session => session.auth_time * 1000 > Date.now() - FRESH_MS;
async function requireSession(request, env) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in to an app first, then return to your account.', 401);
    return session;
}
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
    const sessionRows = sessions.results.map(s => `<li>${e(s.device || 'Unknown device')}${s.location ? ` · ${e(s.location)}` : ''} · signed in ${e(when(s.auth_time * 1000))} with ${e(s.method)} · last active ${e(when(s.last_seen))}
${s.sid === session.sid ? ' <strong>(this browser)</strong>' : action(request, '/account/sessions', hidden('sid', s.sid), 'Sign out')}</li>`).join('');
    const appRows = apps.results.map(a => `<li>${e(JSON.parse(a.branding).name || a.client_id)} · since ${e(when(a.signed_in))}
${action(request, '/account/apps', hidden('client_id', a.client_id), 'Sign out of this app')}</li>`).join('');
    const deviceRows = devices.results.map(d => `<li>${e(d.name)} · until ${e(when(d.expires_at))}${action(request, '/account/devices', hidden('device', d.hash), 'Forget')}</li>`).join('');
    return page('Your account', `<h1>Your account</h1>${message ? `<p role="status">${e(message)}</p>` : ''}
<h2>Profile</h2><p>Email: ${e(user.email)}${user.email_verified ? '' : ' (not yet confirmed: sign in with an email link)'}</p>
${action(request, '/account/profile', `<label for="display_name">Name</label><input id="display_name" name="display_name" maxlength="100" value="${e(user.display_name || '')}">`, 'Save name')}
${action(request, '/account/email', `<label for="new_email">New email address</label><input id="new_email" name="new_email" type="email" maxlength="254" required>`, 'Change email')}
<p>Changing your email needs a sign-in by email link within the last ten minutes. We confirm the new address by email and tell the old one.</p>
<h2>Security</h2><p>Password: ${password ? `set ${e(when(password.updated))} · <a href="/account/password">Change</a>` : 'none · set one from an app that offers passwords'}</p>
<p>Two-factor: ${factors.length ? `${factors.length} authenticator${factors.length > 1 ? 's' : ''}` : 'off'} · <a href="/account/mfa">Manage</a></p>
<h3>Remembered browsers</h3>${deviceRows ? `<ul>${deviceRows}</ul>` : '<p>None.</p>'}
<h2 id="sessions">Signed-in sessions</h2><ul>${sessionRows}</ul>${sessions.results.length > 1 ? action(request, '/account/sessions', hidden('sid', 'others'), 'Sign out everywhere else') : ''}
<h2 id="apps">Apps</h2>${appRows ? `<ul>${appRows}</ul>` : '<p>No app sessions.</p>'}
${await agentsSection(request, env, session)}
<h2>Delete account</h2><p>This signs you out of every app and agent and removes your sign-in methods. Apps keep their own records of you.</p>
${action(request, '/account/delete', `<label for="confirm_email">Type your email to confirm</label><input id="confirm_email" name="confirm_email" autocomplete="off" required>`, 'Delete my account')}`);
}
export async function accountAction(request, env, ctx) {
    const session = await requireSession(request, env);
    const url = new URL(request.url), what = url.pathname.slice('/account/'.length);
    if (request.method === 'GET' && what === 'email/confirm') return confirmEmailPage(request, session);
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    const now = Date.now();
    if (what === 'profile') {
        const name = typeof body.display_name === 'string' ? body.display_name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim() : '';
        invariant(name.length <= 100, 'invalid_request', 'Use at most 100 characters.');
        await env.DB.prepare('UPDATE users SET display_name=? WHERE id=?').bind(name || null, session.user_id).run();
        await audit(env, 'profile_updated', session.user_id, { fields: ['display_name'] });
        return accountHome(request, env, session, 'Name saved.');
    }
    if (what === 'sessions') {
        invariant(typeof body.sid === 'string' && body.sid.length > 0 && body.sid.length <= 64, 'invalid_request', 'Session required.');
        const others = body.sid === 'others';
        invariant(others || body.sid !== session.sid, 'invalid_request', 'Use Sign out to end this browser\'s session.');
        await env.DB.batch([...(others ? logoutStatements(env, session.user_id, null, session.sid) : logoutStatements(env, session.user_id, body.sid)),
            others ? env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND sid<>?').bind(session.user_id, session.sid)
                : env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND sid=?').bind(session.user_id, body.sid)]);
        ctx.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
        await audit(env, 'sessions_revoked', session.user_id, { scope: others ? 'others' : 'one' });
        return accountHome(request, env, session, others ? 'Signed out everywhere else.' : 'Signed out.');
    }
    if (what === 'apps') {
        invariant(typeof body.client_id === 'string' && body.client_id.length <= 200, 'invalid_request', 'App required.');
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created) SELECT lower(hex(randomblob(16))),a.client_id,a.user_id,NULL,c.backchannel_uri,?
                FROM app_sessions a JOIN clients c ON c.id=a.client_id WHERE a.user_id=? AND a.client_id=? GROUP BY a.client_id`).bind(now, session.user_id, body.client_id),
            env.DB.prepare('DELETE FROM app_sessions WHERE user_id=? AND client_id=?').bind(session.user_id, body.client_id)]);
        ctx.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
        await audit(env, 'app_signed_out', session.user_id, { client_id: body.client_id });
        return accountHome(request, env, session, 'Signed out of the app.');
    }
    if (what === 'devices') {
        invariant(typeof body.device === 'string' && /^[0-9a-f]{64}$/.test(body.device), 'invalid_request', 'Device required.');
        await env.DB.prepare('DELETE FROM trusted_devices WHERE hash=? AND user_id=?').bind(body.device, session.user_id).run();
        return accountHome(request, env, session, 'Browser forgotten.');
    }
    if (what === 'email') return startEmailChange(request, env, ctx, session, body);
    if (what === 'email/confirm') return confirmEmailChange(request, env, ctx, session, body);
    if (what === 'delete') return deleteAccount(request, env, ctx, session, body);
    invariant(false, 'not_found', 'Unknown account action.', 404);
}
async function startEmailChange(request, env, ctx, session, body) {
    // Proof at both ends: a fresh email link for the current address now, and a link to the new one below.
    invariant(freshMailbox(session), 'reauth_required', 'Sign in with an email link (within ten minutes) before changing your email.', 403);
    const email = normalizeEmail(body.new_email);
    invariant(email !== session.email.toLowerCase(), 'invalid_request', 'That is already your email.');
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(browser), 'browser_binding', 'Reload the account page and try again.', 403);
    invariant(env.EMAIL?.send && env.EMAIL_FROM, 'email_config', 'Transactional email is not configured.', 503);
    const token = randomToken(), now = Date.now();
    await env.DB.batch([env.DB.prepare('DELETE FROM email_changes WHERE user_id=?').bind(session.user_id),
        env.DB.prepare('INSERT INTO email_changes(hash,user_id,new_email,browser_hash,expires_at) VALUES(?,?,?,?,?)').bind(await sha256(token), session.user_id, email, await sha256(browser), now + 900000)]);
    ctx.waitUntil(env.EMAIL.send({ from: env.EMAIL_FROM, to: email, subject: `${env.REALM.display_name}: confirm your new email`,
        text: `Open this link in the browser where you asked for the change, then choose Confirm. It expires in 15 minutes.\n\n${env.ISSUER}/account/email/confirm?token=${token}\n\nIgnore this email if you did not ask for it.` })
        .catch(error => console.error(JSON.stringify({ type: 'email_change_failed', code: error?.code || 'send_failed' }))));
    notify(env, ctx, session.email, 'email change requested', `Someone signed in to your account asked to change its email to ${email}. Nothing changes until that address is confirmed.`);
    return accountHome(request, env, session, `We sent a confirmation link to ${email}.`);
}
// GET shows a confirm button; only the POST changes anything, so link scanners cannot.
function confirmEmailPage(request, session) {
    const token = uniqueParams(new URL(request.url).searchParams).token;
    invariant(tokenShape(token), 'invalid_request', 'Invalid confirmation link.');
    return page('Confirm new email', `<h1>Confirm your new email</h1><p>Signed in as ${e(session.email)}.</p>
${action(request, '/account/email/confirm', hidden('token', token), 'Confirm')}`);
}
async function confirmEmailChange(request, env, ctx, session, body) {
    invariant(tokenShape(body.token) && tokenShape(cookies(request)[BROWSER_COOKIE]), 'invalid_grant', 'Invalid confirmation link.', 400);
    const row = await env.DB.prepare('DELETE FROM email_changes WHERE hash=? AND user_id=? AND browser_hash=? AND expires_at>? RETURNING *')
        .bind(await sha256(body.token), session.user_id, await sha256(cookies(request)[BROWSER_COOKIE]), Date.now()).first();
    invariant(row, 'invalid_grant', 'This link expired, was used, or belongs to another account or browser.', 400);
    const old = session.email;
    try {
        await env.DB.batch([env.DB.prepare('UPDATE users SET email=?,email_verified=1 WHERE id=?').bind(row.new_email, session.user_id),
            env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES('email_changed',?,'{}',?,?)").bind(session.user_id, Date.now(), env.REALM.id)]);
    } catch (error) {
        invariant(!String(error.message).includes('UNIQUE'), 'conflict', 'That address belongs to another account.', 409);
        throw error;
    }
    notify(env, ctx, old, 'your email was changed', `Your account's email changed from ${old} to ${row.new_email}. If you did not do this, contact the app you use.`);
    return redirect(`${env.ISSUER}/account?changed=email`);
}
async function deleteAccount(request, env, ctx, session, body) {
    invariant(typeof body.confirm_email === 'string' && body.confirm_email.trim().toLowerCase() === session.email.toLowerCase(), 'invalid_request', 'Type your email exactly to confirm.');
    invariant(freshSignIn(session), 'reauth_required', 'Sign in again (within ten minutes) before deleting your account.', 403);
    if ((await confirmedFactors(env, session.user_id)).length)
        invariant(session.mfa_at && session.mfa_at > Date.now() - FRESH_MFA_MS, 'mfa_required', 'Enter a second-factor code at /mfa?next=/account first.', 403);
    const id = session.user_id, now = Date.now();
    // Ends identity and app sessions (back-channel), agent grants (revocation events) and every sign-in method.
    await env.DB.batch([...endAccess(env, id),
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
