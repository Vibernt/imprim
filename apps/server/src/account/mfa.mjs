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
import { accountPage } from '../pages/shell.mjs';
import { heading, section, button, linkButton, field, otp, OTP_MODULE, hidden, callout, list, empty, setting, badge, small } from '../pages/ui.mjs';
import { credentials } from '../webauthn/ceremonies.mjs';
import { notify } from '../services/notify.mjs';
const FRESH_AUTH_MS = 600000;
const csrfOf = request => cookies(request)[CSRF_COOKIE] || '';
const carry = values => hidden('request_id', values.request_id) + hidden('next', values.next);
// A form that posts one action to /account/mfa; `body` and `submit` are already-safe markup.
const post = (request, values, action, body, submit, layout = '') => `<form${layout} method="post" action="/account/mfa">${hidden('csrf', csrfOf(request))}${carry(values)}${hidden('action', action)}${body}${submit}</form>`;
// Short dates in UTC, as WRITING.md asks: "Nov 15, 2026".
const day = time => e(new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
// Recovery codes as a two-column grid of mono codes; tests/support/admin.mjs reads them from this markup.
const recoveryCodes = codes => `<div class="fd-card" data-variant="sunken"><ul class="fd-grid" data-cols="2" data-min="4xs" data-gap="2" id="recovery-codes" aria-label="Recovery codes">${codes.map(code => `<li><code class="fd-code">${e(code)}</code></li>`).join('')}</ul></div>`;
// Where "Cancel" returns to, keeping the app request (or the page to go back to) the person arrived with.
const overviewHref = values => {
    const query = new URLSearchParams(Object.entries({ request_id: values.request_id, next: values.next }).filter(([, v]) => typeof v === 'string' && v));
    return `/account/mfa${query.size ? `?${query}` : ''}`;
};
// Mid sign-in (an app is waiting) each step is a centred screen; otherwise it sits in the account pages, under Security.
const show = (values, title, description, body, options = {}) => values.request_id ? page(title, heading(title, description) + body, { size: 'md', ...options })
    : accountPage(title, body, { active: 'security', description, back: ['Security', '/account/security'], ...options });
const audit = (env, event, userId, detail = {}) => env.DB.prepare('INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,?,?,?)').bind(event, userId, JSON.stringify(detail), Date.now(), env.REALM.id);
async function overview(request, env, session, values, message = '') {
    const all = await confirmedFactors(env, session.user_id), factors = all.filter(f => f.type === 'totp'), passkeys = await credentials(env, session.user_id);
    const left = (await env.DB.prepare('SELECT count(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL').bind(session.user_id).first()).n;
    const toConsole = !all.length && typeof values.next === 'string' && /^\/admin(\/|$)/.test(values.next);
    const required = values.request_id ? callout('Add a second factor to continue', 'This app asks for a code or a passkey after you sign in.', { tone: 'warning', role: 'alert' })
        : toConsole ? callout('Add a second factor to open the admin console', 'Administrators need an authenticator app or a passkey. You go on to the console once it is added.', { tone: 'warning', role: 'alert' }) : '';
    const notice = message ? callout(message, '', { tone: 'success', role: 'status' }) : '';
    const add = post(request, values, 'start', '', button('Add authenticator app', { variant: all.length ? 'outline' : 'primary', icon: 'plus' }));
    const apps = factors.length ? list('Authenticator apps', factors.map(f => ({ title: f.name, desc: `Added ${day(f.created)} · ${f.last_used ? `last used ${day(f.last_used)}` : 'never used'}`,
        trail: post(request, values, 'remove', hidden('factor_id', f.id), button('Remove', { variant: 'ghost', size: 'sm', 'aria-label': `Remove ${f.name}` })) }))) + `<div class="fd-row">${add}</div>`
        : empty('No authenticator app yet', 'Add one to enter a 6-digit code each time you sign in.', add);
    const keys = passkeys.length ? list('Passkeys', passkeys.map(p => ({ title: p.name, desc: `Added ${day(p.created)}`, meta: p.backup_eligible ? badge('Synced') : '',
        trail: `<form method="post" action="/account/passkeys/remove">${hidden('csrf', csrfOf(request))}${hidden('id', p.id)}${button('Remove', { variant: 'ghost', size: 'sm', 'aria-label': `Remove ${p.name}` })}</form>` })))
        : empty('No passkeys yet', 'Add one to use your fingerprint, face or device PIN.');
    // The passkey name has no form: /assets/passkey.js reads #passkey-name and wires #passkey-add.
    const addKey = `<div class="fd-row" data-align="end" data-wrap data-gap="3"><div class="fd-grow">${field({ id: 'passkey-name', label: 'Passkey name', maxlength: 60, placeholder: 'Work laptop', hint: 'Leave blank to name it “Passkey”.' })}</div>${button('Add passkey', { id: 'passkey-add', type: 'button', variant: 'outline', icon: 'key-round' })}</div>`;
    const codes = all.length ? section('Recovery codes', 'Each code works once, for when you can’t use your app or passkey.',
        setting(left ? `${left} unused ${left === 1 ? 'code' : 'codes'}` : 'No unused codes', 'New codes replace every old one.', post(request, values, 'recovery', '', button('Generate new codes', { variant: 'outline', size: 'sm', icon: 'refresh-cw' })))) : '';
    return show(values, 'Two-factor authentication', 'Ask for a code or a passkey each time you sign in.', required + notice +
        section('Authenticator apps', 'Apps that show a new 6-digit code every 30 seconds.', apps) +
        section('Passkeys', 'Sign in with this device’s screen lock instead of a code.', keys + addKey + '<p class="fd-small" id="message" role="status" aria-live="polite"></p>') +
        codes, { script: '/assets/passkey.js' });
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
        const key = `<div class="fd-stack" data-gap="2"><p class="fd-small fd-muted">Can’t scan it? Enter this setup key in the app instead.</p><p><code class="fd-code" id="totp-secret">${e(secret.match(/.{1,4}/g).join(' '))}</code></p></div>`;
        const confirm = post(request, values, 'confirm', hidden('factor_id', id) +
            field({ id: 'name', label: 'Name', name: 'name', value: 'Authenticator app', maxlength: 60, required: true, hint: 'Shown in your list, so you can tell your apps apart.' }) +
            otp({ id: 'code', label: 'Code', name: 'code' }),
            `<div class="fd-form-actions">${linkButton('Cancel', overviewHref(values), { variant: 'ghost' })}${button('Add authenticator app', { variant: 'primary' })}</div>`, ' class="fd-form"');
        return show(values, 'Add an authenticator app', 'Scan the code, then enter the 6-digit code your app shows.',
            `<div class="fd-stack" data-gap="4"><figure class="fd-qr">${qrSvg(uri, { label: 'Authenticator setup code' })}</figure>${key}</div>` + confirm, { modules: [OTP_MODULE] });
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
        const saved = recovery.codes.length ? callout('Save these recovery codes now', 'They are shown once. Each code signs you in one time if you lose your authenticator app.', { tone: 'warning' }) +
            recoveryCodes(recovery.codes) + small('Keep them in a password manager or somewhere offline. Anyone with a code can pass this step.') : '';
        return show(values, 'Two-factor authentication is on', 'Sign-ins now ask for a code from this app.',
            saved + post(request, values, 'continue', '', values.request_id ? button('Continue', { variant: 'primary', size: 'lg', block: true }) : `<div class="fd-row">${button('Continue', { variant: 'primary' })}</div>`));
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
        return overview(request, env, session, values, 'Authenticator app removed');
    }
    if (values.action === 'recovery') {
        invariant(factors.length, 'invalid_request', 'Add a second factor first.');
        const recovery = await recoveryStatements(env, session.user_id);
        await env.DB.batch([...recovery.statements, audit(env, 'recovery_codes_regenerated', session.user_id)]);
        notify(env, ctx, session.email, 'new recovery codes were generated', 'Your recovery codes were replaced. The old ones no longer work.');
        return show(values, 'New recovery codes', 'Your old codes stopped working. Save these before you leave.',
            callout('Save these codes now', 'They are shown once. Each code signs you in one time.', { tone: 'warning' }) + recoveryCodes(recovery.codes) +
            small('Keep them in a password manager or somewhere offline. Anyone with a code can pass this step.') + `<div class="fd-row">${linkButton('Done', '/account/mfa', { variant: 'primary' })}</div>`);
    }
    invariant(false, 'invalid_request', 'Unknown action.');
}
