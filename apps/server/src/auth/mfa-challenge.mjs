// /mfa: the second-factor step between primary sign-in and the app (or the admin console).
import { readBody, redirect, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE, sessionByHash } from './session.mjs';
import { attempt, clearFailures, mfaFailureKey } from './rate-limit.mjs';
import { verifySecondFactor, mfaStatement, trustBrowser, confirmedFactors, ACR_MFA } from './mfa.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { page, escapeHtml } from '../pages/layout.mjs';
import { result, field, otp, checkbox, hidden, button, orDivider as or } from '../pages/ui.mjs';
import { FORMS_MODULE } from '../pages/forms.mjs';
import { notify } from '../services/notify.mjs';
import { t, scriptPath } from '../i18n/index.mjs';
// Where a finished second factor may send the person when there is no authorization request.
export const safeNext = value => typeof value === 'string' && (
    /^\/(admin|account)(\/[A-Za-z0-9/_.-]*)?(\?[A-Za-z0-9=&%_.-]*)?$/.test(value) ||
    /^\/machine-client\?request_id=[0-9a-f]{32}$/.test(value)) ? value : '/account';
// The page wears the app's brand (client) when the step is part of an app's sign-in.
// The authenticator code goes in one-time-code boxes; a recovery code (longer, with letters) has its own field, reached
// by a link, so each field takes exactly one kind of code. The POST accepts either.
function challenge(env, request, values, { trust, message = '', passkey = false, client = null }) {
    const recovery = values.recovery === '1';
    const other = new URLSearchParams(Object.entries({ recovery: recovery ? '' : '1', request_id: values.request_id, next: values.next }).filter(([, v]) => typeof v === 'string' && v));
    const code = recovery
        ? field({ id: 'code', label: t(env, 'Recovery code'), name: 'code', size: 'lg', inputmode: 'text', autocapitalize: 'characters', spellcheck: 'false', autocomplete: 'off', maxlength: 11, required: true, autofocus: true,
            error: message || undefined, hint: message ? undefined : t(env, 'One of the codes you saved when you turned on two-factor. Each works once.') })
        : otp({ id: 'code', label: t(env, 'Code'), name: 'code', autofocus: true, error: message || undefined });
    const form = `<form class="fd-stack" data-gap="4" method="post" action="/mfa">${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}${hidden('request_id', values.request_id)}${hidden('next', values.next)}${recovery ? hidden('recovery', '1') : ''}
${code}
${trust ? checkbox('trust', t(env, 'Trust this browser for {days} days', { days: trust })) : ''}${button(t(env, 'Continue'), { variant: 'primary', size: 'lg', block: true })}</form>`;
    const alternative = passkey ? or(env) + button(t(env, 'Use a passkey instead'), { id: 'passkey-mfa', type: 'button', 'data-request-id': values.request_id || '', 'data-next': values.next || '', variant: 'outline', size: 'lg', block: true, icon: 'key-round' }) : '';
    const swap = `<p class="fd-screen-note"><span>${escapeHtml(recovery ? t(env, 'Have your phone?') : t(env, 'Lost your authenticator?'))} <a class="fd-link" href="/mfa${other.size ? `?${escapeHtml(String(other))}` : ''}">${escapeHtml(recovery ? t(env, 'Enter a code from your app') : t(env, 'Use a recovery code'))}</a></span></p>`;
    const head = recovery ? result('shield-check', 'accent', t(env, 'Enter a recovery code'), t(env, 'Use it in place of your authenticator app.'))
        : result('shield-check', 'accent', t(env, 'Enter your code'), t(env, 'Open your authenticator app and enter the 6-digit code.'));
    return page(t(env, 'Second step'), head + `<section class="fd-stack" data-gap="3">${form}${alternative}</section>${swap}<p class="fd-small" id="message" role="status" aria-live="polite"></p>`,
        { status: message ? 401 : 200, script: passkey ? scriptPath(env, '/assets/passkey.js') : '', modules: recovery ? [] : [FORMS_MODULE], client });
}
async function context(env, request, values) {
    if (!values.request_id) return { pending: null, trust: 0 };
    const pending = await pendingRequest(env, request, values.request_id);
    const demanded = (pending.row.acr_values || '').split(' ').includes(ACR_MFA);
    return { pending, trust: demanded ? 0 : pending.client.mfa_trusted_device_days };
}
export async function mfaChallenge(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    invariant((await confirmedFactors(env, session.user_id)).length, 'mfa_enrolment_required', 'Add a second factor at /account/mfa first.', 403);
    const values = request.method === 'POST' ? await readBody(request, 'form') : uniqueParams(new URL(request.url).searchParams);
    const { pending, trust } = await context(env, request, values);
    const passkey = (await confirmedFactors(env, session.user_id)).some(f => f.type === 'passkey');
    const client = pending?.client ?? null;
    if (request.method === 'GET') return challenge(env, request, values, { trust, passkey, client });
    await requireCsrf(request, env, session, values.csrf);
    const key = mfaFailureKey(session.user_id);
    invariant(await attempt(env, key), 'rate_limit', 'Too many attempts. Wait fifteen minutes and try again.', 429);
    const result = await verifySecondFactor(env, session.user_id, values.code);
    if (!result) return challenge(env, request, values, { trust, passkey, client, message: values.recovery === '1' ? t(env, 'That code didn’t work. Check it, or use another recovery code.') : t(env, 'That code didn’t work. Enter the newest code from your app.') });
    await clearFailures(env, key);
    await env.DB.batch([mfaStatement(env, session, result.amr),
        env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,'{}',?,?)").bind(result.kind === 'recovery' ? 'recovery_code_used' : 'mfa_verified', session.user_id, Date.now(), env.REALM.id)]);
    if (result.kind === 'recovery') notify(env, ctx, session.email, 'recovery_code_used');
    const responseCookies = values.trust === '1' && trust ? [await trustBrowser(env, session.user_id, pending.client.id, trust, request)] : [];
    const current = await sessionByHash(env, session.hash);
    if (pending) return completeAuthorization(env, request, pending.row.id, current, responseCookies);
    return redirect(`${env.ISSUER}${safeNext(values.next)}`, responseCookies);
}
