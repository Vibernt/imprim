// /account/mfa: add an authenticator app, see and regenerate recovery codes, remove a factor.
import { readBody, redirect, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE, sessionByHash } from '../auth/session.mjs';
import { confirmedFactors } from '../auth/mfa.mjs';
import { changeFactor, readFactors, requireVerifiedFactorEmail } from './factors.mjs';
import { pendingRequest, completeAuthorization, requireAuthorizationSession } from '../oidc/requests.mjs';
import { safeNext } from '../auth/mfa-challenge.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { accountPage } from '../pages/shell.mjs';
import { accountLine, heading, section, button, linkButton, field, otp, hidden, callout, list, setting, badge, small, messageBox } from '../pages/ui.mjs';
import { FORMS_MODULE } from '../pages/forms.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { renamePasskey } from '../webauthn/rename.mjs';
import { t, tPlural, formatDate, scriptPath } from '../i18n/index.mjs';
const csrfOf = request => cookies(request)[CSRF_COOKIE] || '';
const carry = values => hidden('request_id', values.request_id) + hidden('next', values.next);
// A form that posts one action to /account/mfa; `body` and `submit` are already-safe markup.
const post = (request, values, action, body, submit, layout = '') => `<form${layout} method="post" action="/account/mfa">${hidden('csrf', csrfOf(request))}${carry(values)}${hidden('action', action)}${body}${submit}</form>`;
// Short dates in UTC, as WRITING.md asks: "Nov 15, 2026".
const day = (env, time) => formatDate(env, time, { month: 'short', day: 'numeric', year: 'numeric' });
// Recovery codes as a two-column grid of mono codes; tests/support/admin.mjs reads them from this markup.
const recoveryCodes = (env, codes) => `<div><ul class="fd-grid" data-cols="2" data-min="4xs" data-gap="2" id="recovery-codes" aria-label="${e(t(env, 'Recovery codes'))}">${codes.map(code => `<li><code class="fd-code">${e(code)}</code></li>`).join('')}</ul></div>`;
// Where "Cancel" returns to, keeping the app request (or the page to go back to) the person arrived with.
const overviewHref = values => {
    const query = new URLSearchParams(Object.entries({ request_id: values.request_id, next: values.next }).filter(([, v]) => typeof v === 'string' && v));
    return `/account/mfa${query.size ? `?${query}` : ''}`;
};
// Mid sign-in (an app is waiting) each step is a centred screen; otherwise it sits in the account pages, under Security.
const show = (env, session, values, title, description, body, options = {}) => values.request_id
    ? page(title, heading(title, description) + accountLine(env, values.email, { id: values.request_id, csrf: values.csrfToken }) + body,
        { size: 'md', client: values.client, formTargets: [values.redirectUri], ...options })
    : accountPage(title, body, { env, session, active: 'security', description, back: [t(env, 'Security'), '/account/security'], ...options });
async function overview(request, env, session, values, message = '') {
    const { factors, passkeys, recovery_count: left } = await readFactors(env, session);
    const hasFactor = factors.length + passkeys.length > 0;
    const toConsole = !hasFactor && typeof values.next === 'string' && /^\/admin(\/|$)/.test(values.next);
    const required = values.request_id && !hasFactor ? callout('', t(env, '{app} asks for a second step after you sign in. Add an authenticator app or a passkey.',
        { app: brandingFor(env, values.client).name || values.client.id }), { tone: 'info' })
        : toConsole ? callout(t(env, 'Add a second factor to open the admin console'), t(env, 'Administrators need an authenticator app or a passkey. You go on to the console once it is added.'), { tone: 'warning', role: 'alert' }) : '';
    const notice = message ? callout(message, '', { tone: 'success', role: 'status' }) : '';
    const add = post(request, values, 'start', '', button(t(env, 'Add authenticator app'), { variant: hasFactor ? 'outline' : 'primary', icon: 'plus' }));
    const apps = factors.length ? list(t(env, 'Authenticator apps'), factors.map(f => ({ title: f.name, desc: e(`${t(env, 'Added {date}', { date: day(env, f.created) })} · ${f.last_used ? t(env, 'last used {date}', { date: day(env, f.last_used) }) : t(env, 'never used')}`),
        trail: post(request, values, 'remove', hidden('factor_id', f.id), button(t(env, 'Remove'), { variant: 'ghost', size: 'lg', 'aria-label': t(env, 'Remove {name}', { name: f.name }) })) })), { divided: Boolean(values.request_id) }) + `<div class="fd-row">${add}</div>`
        : `<p class="fd-body">${e(t(env, 'No authenticator app yet'))}</p><div class="fd-row">${add}</div>`;
    const keys = passkeys.length ? list(t(env, 'Passkeys'), passkeys.map(p => ({ title: p.name, desc: e(t(env, 'Added {date}', { date: day(env, p.created) })), meta: p.backup_eligible ? badge(t(env, 'Synced')) : '',
        trail: `<form method="post" action="/account/passkeys/remove">${hidden('csrf', csrfOf(request))}${hidden('id', p.id)}${button(t(env, 'Remove'), { variant: 'ghost', size: 'lg', 'aria-label': t(env, 'Remove {name}', { name: p.name }) })}</form>` })), { divided: Boolean(values.request_id) })
        : `<p class="fd-body">${e(t(env, 'No passkeys yet'))}</p>`;
    const addKey = button(t(env, 'Add passkey'), { id: 'passkey-add', type: 'button', variant: 'outline', size: 'lg', icon: 'key-round' });
    const nameKey = `<form class="fd-form" method="post" action="/account/mfa" id="passkey-rename" hidden>
${hidden('csrf', csrfOf(request))}${carry(values)}${hidden('action', 'rename-passkey')}${hidden('id', '')}
${field({ id: 'passkey-name', name: 'name', label: t(env, 'Passkey name'), maxlength: 60, required: true })}
<div class="fd-row" data-wrap>${button(t(env, 'Save name'), { variant: 'outline', size: 'lg' })}
<a class="fd-link" href="${e(overviewHref(values))}">${e(t(env, 'Keep the default name'))}</a></div></form>`;
    const continueSignIn = values.request_id && hasFactor && session.mfa_at
        ? post(request, values, 'continue', '', button(t(env, 'Continue'), { variant: 'primary', size: 'lg', block: true })) : '';
    const codes = hasFactor ? section(t(env, 'Recovery codes'), t(env, 'Each code works once, for when you can’t use your app or passkey.'),
        setting(left ? tPlural(env, left, '{count} unused code', '{count} unused codes') : t(env, 'No unused codes'), t(env, 'New codes replace every old one.'), post(request, values, 'recovery', '', button(t(env, 'Generate new codes'), { variant: 'outline', size: 'sm', icon: 'refresh-cw' })))) : '';
    return show(env, session, values, t(env, 'Two-factor authentication'), t(env, 'Ask for a code or a passkey each time you sign in.'), required + notice +
        section(t(env, 'Authenticator apps'), t(env, 'Apps that show a new 6-digit code every 30 seconds.'), apps) +
        section(t(env, 'Passkeys'), t(env, 'Sign in with this device’s screen lock instead of a code.'), keys + `<div class="fd-row">${addKey}</div>${messageBox()}` + nameKey) +
        codes + continueSignIn, { script: scriptPath(env, '/assets/passkey.js') });
}
export async function mfaAccount(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    requireVerifiedFactorEmail(session);
    const get = request.method === 'GET';
    const values = get ? uniqueParams(new URL(request.url).searchParams) : await readBody(request, 'form');
    if (!get) await requireCsrf(request, env, session, values.csrf);
    const pending = values.request_id ? await pendingRequest(env, request, values.request_id) : null;
    if (pending) {
        requireAuthorizationSession(pending.row, session);
        Object.assign(values, { client: pending.client, redirectUri: pending.row.redirect_uri, email: session.email, csrfToken: csrfOf(request) });
    }
    if (get) {
        if (values.verify === '1' && !values.request_id && (await confirmedFactors(env, session.user_id)).length)
            return redirect(`/mfa?next=${encodeURIComponent(safeNext(values.next))}`);
        return overview(request, env, session, values);
    }
    if (values.action === 'rename-passkey') {
        await renamePasskey(env, session, values);
        return redirect(overviewHref(values));
    }
    if (values.action === 'continue') {
        if (pending) {
            return completeAuthorization(env, request, pending.row.id, await sessionByHash(env, session.hash));
        }
        return redirect(`${env.ISSUER}${values.next ? safeNext(values.next) : '/account/mfa'}`);
    }
    const result = await changeFactor(env, ctx, session, values.action, values);
    if (values.action === 'start') {
        const { factor_id: id, secret, qr, name } = result;
        const key = `<div class="fd-stack" data-gap="2"><p class="fd-small fd-muted">${e(t(env, 'Can’t scan it? Enter this setup key in the app instead.'))}</p><p><code class="fd-code" id="totp-secret">${e(secret)}</code></p></div>`;
        const confirm = post(request, values, 'confirm', hidden('factor_id', id) +
            field({ id: 'name', label: t(env, 'Name'), name: 'name', value: name, maxlength: 60, required: true, hint: t(env, 'Shown in your list, so you can tell your apps apart.') }) +
            otp({ id: 'code', label: t(env, 'Code'), name: 'code' }),
            `<div class="fd-form-actions">${linkButton(t(env, 'Cancel'), overviewHref(values), { variant: 'ghost' })}${button(t(env, 'Add authenticator app'), { variant: 'primary' })}</div>`, ' class="fd-form"');
        return show(env, session, values, t(env, 'Add an authenticator app'), t(env, 'Scan the code, then enter the 6-digit code your app shows.'),
            `<div class="fd-stack" data-gap="4"><figure class="fd-qr">${qr}</figure>${key}</div>` + confirm, { modules: [FORMS_MODULE] });
    }
    if (values.action === 'confirm') {
        const { recovery_codes: codes } = result;
        const saved = codes.length ? callout(t(env, 'Save these recovery codes now'), t(env, 'They are shown once. Each code signs you in one time if you lose your authenticator app.'), { tone: 'warning' }) +
            recoveryCodes(env, codes) + small(t(env, 'Keep them in a password manager or somewhere offline. Anyone with a code can pass this step.')) : '';
        return show(env, session, values, t(env, 'Two-factor authentication is on'), t(env, 'Sign-ins now ask for a code from this app.'),
            saved + post(request, values, 'continue', '', values.request_id ? button(t(env, 'Continue'), { variant: 'primary', size: 'lg', block: true }) : `<div class="fd-row">${button(t(env, 'Continue'), { variant: 'primary' })}</div>`));
    }
    if (values.action === 'remove') return overview(request, env, session, values, t(env, 'Authenticator app removed'));
    if (values.action === 'recovery') {
        const { recovery_codes: codes } = result;
        return show(env, session, values, t(env, 'New recovery codes'), t(env, 'Your old codes stopped working. Save these before you leave.'),
            callout(t(env, 'Save these codes now'), t(env, 'They are shown once. Each code signs you in one time.'), { tone: 'warning' }) + recoveryCodes(env, codes) +
            small(t(env, 'Keep them in a password manager or somewhere offline. Anyone with a code can pass this step.')) + `<div class="fd-row">${linkButton(t(env, 'Done'), '/account/mfa', { variant: 'primary' })}</div>`);
    }
    invariant(false, 'invalid_request', 'Unknown action.');
}
