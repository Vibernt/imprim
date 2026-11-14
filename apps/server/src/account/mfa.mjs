// /account/mfa: add an authenticator app, see and regenerate recovery codes, remove a factor.
import { readBody, redirect, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE, sessionByHash } from '../auth/session.mjs';
import { confirmedFactors, sealTotp, recoveryStatements, mfaStatement, forgetDevices, FRESH_MFA_MS } from '../auth/mfa.mjs';
import { newSecret, matchingStep, otpauthUri } from '../auth/totp.mjs';
import { unseal } from '../lib/crypto.mjs';
import { qrSvg } from '../lib/qr.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { safeNext } from '../auth/mfa-challenge.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { credentials } from '../webauthn/ceremonies.mjs';
import { notify } from '../services/notify.mjs';
const FRESH_AUTH_MS = 600000;
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${e(value ?? '')}">`;
const csrfOf = request => cookies(request)[CSRF_COOKIE] || '';
const carry = values => hidden('request_id', values.request_id) + hidden('next', values.next);
const post = (request, values, action, body, label) => `<form method="post" action="/account/mfa">${hidden('csrf', csrfOf(request))}${carry(values)}${hidden('action', action)}${body}<button>${e(label)}</button></form>`;
const audit = (env, event, userId, detail = {}) => env.DB.prepare('INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,?,?,?)').bind(event, userId, JSON.stringify(detail), Date.now(), env.REALM.id);
async function overview(request, env, session, values, message = '') {
    const all = await confirmedFactors(env, session.user_id), factors = all.filter(f => f.type === 'totp'), passkeys = await credentials(env, session.user_id);
    const left = (await env.DB.prepare('SELECT count(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL').bind(session.user_id).first()).n;
    const required = values.request_id ? '<p role="alert">This app requires a second factor. Add one to continue.</p>' : '';
    return page('Two-factor authentication', `<h1>Two-factor authentication</h1>${required}${message ? `<p role="status">${e(message)}</p>` : ''}
${all.length ? `<h2>Authenticator apps</h2>${factors.map(f => `<section><p><strong>${e(f.name)}</strong> · added ${e(new Date(f.created).toISOString().slice(0, 10))}${f.last_used ? ` · last used ${e(new Date(f.last_used).toISOString().slice(0, 10))}` : ''}</p>
${post(request, values, 'remove', hidden('factor_id', f.id), 'Remove')}</section>`).join('')}
<h2>Recovery codes</h2><p>${left} unused. Each works once if you lose your authenticator.</p>${post(request, values, 'recovery', '', 'Generate new recovery codes')}` : '<p>No second factor yet.</p>'}
<h2>Add an authenticator app</h2>${post(request, values, 'start', '', 'Add authenticator app')}
<h2>Passkeys</h2>${passkeys.map(p => `<section><p><strong>${e(p.name)}</strong> · added ${e(new Date(p.created).toISOString().slice(0, 10))}${p.backup_eligible ? ' · synced' : ''}</p>
<form method="post" action="/account/passkeys/remove">${hidden('csrf', csrfOf(request))}${hidden('id', p.id)}<button>Remove</button></form></section>`).join('')}
<label for="passkey-name">Passkey name</label><input id="passkey-name" maxlength="60" value="Passkey"><button id="passkey-add" type="button">Add a passkey</button><p id="message" role="status"></p>`, { script: '/assets/passkey.js' });
}
export async function mfaAccount(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    invariant(session.email_verified === 1, 'access_denied', 'Confirm your email with a sign-in link first.', 403);
    if (request.method === 'GET') return overview(request, env, session, uniqueParams(new URL(request.url).searchParams));
    const values = await readBody(request, 'form');
    await requireCsrf(request, env, session, values.csrf);
    const now = Date.now(), freshMfa = session.mfa_at && session.mfa_at > now - FRESH_MFA_MS;
    const all = await confirmedFactors(env, session.user_id), factors = all;
    // Adding a factor needs a fresh sign-in (or a fresh second factor), so a stolen session cookie cannot enrol one.
    // Someone who already has a factor proves it before adding another; otherwise a sign-in without the second factor
    // could enrol its own and pass every gate.
    if (['start', 'confirm'].includes(values.action) && factors.length)
        invariant(freshMfa, 'mfa_required', 'Enter a code from your current authenticator at /mfa?next=/account/mfa first (within ten minutes).', 403);
    if (values.action === 'start') {
        invariant(session.auth_time * 1000 > now - FRESH_AUTH_MS || freshMfa, 'reauth_required', 'Sign in again (within ten minutes) before adding a second factor.', 403);
        const id = crypto.randomUUID(), secret = newSecret();
        await env.DB.prepare('DELETE FROM mfa_factors WHERE user_id=? AND confirmed=0').bind(session.user_id).run();
        await env.DB.prepare('INSERT INTO mfa_factors(id,user_id,type,name,sealed_secret,created) VALUES(?,?,?,?,?,?)')
            .bind(id, session.user_id, 'totp', 'Authenticator app', await sealTotp(env, id, secret), now).run();
        const uri = otpauthUri({ issuer: env.REALM.display_name, account: session.email, secret });
        return page('Add authenticator app', `<h1>Add an authenticator app</h1><p>Scan this code with your authenticator app, or enter the key by hand.</p>
<figure>${qrSvg(uri, { label: 'Authenticator setup code' })}</figure><p>Key: <code id="totp-secret">${e(secret.match(/.{1,4}/g).join(' '))}</code></p>
${post(request, values, 'confirm', `${hidden('factor_id', id)}<label for="name">Name</label><input id="name" name="name" value="Authenticator app" maxlength="60" required>
<label for="code">Six-digit code from the app</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>`, 'Confirm')}`);
    }
    if (values.action === 'confirm') {
        const factor = await env.DB.prepare('SELECT * FROM mfa_factors WHERE id=? AND user_id=? AND confirmed=0 AND created>?').bind(values.factor_id || '', session.user_id, now - 3600000).first();
        invariant(factor, 'invalid_request', 'Start again: that setup expired.', 400);
        const step = await matchingStep(await unseal(env, factor.sealed_secret, `totp:${factor.id}`), values.code, -1);
        invariant(step !== null, 'invalid_grant', 'That code did not match. Check the time on your phone and try the newest code.', 400);
        const name = typeof values.name === 'string' && values.name.trim() ? values.name.trim().slice(0, 60) : 'Authenticator app';
        const unused = (await env.DB.prepare('SELECT count(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL').bind(session.user_id).first()).n;
        const recovery = unused ? { codes: [], statements: [] } : await recoveryStatements(env, session.user_id);
        // Confirming proves possession, so it also counts as this session's second factor.
        await env.DB.batch([
            env.DB.prepare('UPDATE mfa_factors SET confirmed=1,last_step=?,name=?,last_used=? WHERE id=? AND confirmed=0').bind(step, name, now, factor.id),
            ...recovery.statements, mfaStatement(env, session, ['otp']), forgetDevices(env, session.user_id),
            audit(env, 'mfa_factor_added', session.user_id, { type: 'totp' })]);
        notify(env, ctx, session.email, 'a second factor was added', `An authenticator app ("${name}") was added to your account. Remembered browsers were signed out of their second-factor exemption.`);
        return page('Two-factor authentication on', `<h1>Two-factor authentication is on</h1>${recovery.codes.length ? `<p>Save these recovery codes somewhere safe. Each works once. They will not be shown again.</p>
<ul id="recovery-codes">${recovery.codes.map(code => `<li><code>${e(code)}</code></li>`).join('')}</ul>` : ''}${post(request, values, 'continue', '', 'Continue')}`);
    }
    if (values.action === 'continue') {
        if (values.request_id) {
            const pending = await pendingRequest(env, request, values.request_id);
            return completeAuthorization(env, request, pending.row.id, await sessionByHash(env, session.hash));
        }
        return redirect(`${env.ISSUER}${values.next ? safeNext(values.next) : '/account/mfa'}`);
    }
    // Removing a factor or replacing recovery codes needs a second factor in the last ten minutes.
    invariant(freshMfa, 'mfa_required', 'Enter a code at /mfa?next=/account/mfa first (within ten minutes).', 403);
    if (values.action === 'remove') {
        const factor = factors.find(f => f.id === values.factor_id && f.type === 'totp');
        invariant(factor, 'not_found', 'Factor not found.', 404);
        await env.DB.batch([env.DB.prepare('DELETE FROM mfa_factors WHERE id=? AND user_id=?').bind(factor.id, session.user_id),
            ...(all.length === 1 ? [env.DB.prepare('DELETE FROM recovery_codes WHERE user_id=?').bind(session.user_id)] : []),
            forgetDevices(env, session.user_id), audit(env, 'mfa_factor_removed', session.user_id, { type: factor.type })]);
        notify(env, ctx, session.email, 'a second factor was removed', `The authenticator "${factor.name}" was removed from your account.`);
        return overview(request, env, session, values, 'Removed.');
    }
    if (values.action === 'recovery') {
        invariant(factors.length, 'invalid_request', 'Add a second factor first.');
        const recovery = await recoveryStatements(env, session.user_id);
        await env.DB.batch([...recovery.statements, audit(env, 'recovery_codes_regenerated', session.user_id)]);
        notify(env, ctx, session.email, 'new recovery codes were generated', 'Your recovery codes were replaced. The old ones no longer work.');
        return page('New recovery codes', `<h1>New recovery codes</h1><p>The old codes no longer work. Save these; they will not be shown again.</p>
<ul id="recovery-codes">${recovery.codes.map(code => `<li><code>${e(code)}</code></li>`).join('')}</ul><p><a href="/account/mfa">Back</a></p>`);
    }
    invariant(false, 'invalid_request', 'Unknown action.');
}
