// /mfa: the second-factor step between primary sign-in and the app (or the admin console).
import { readBody, redirect, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { getSession, requireCsrf, cookies, CSRF_COOKIE, sessionByHash } from './session.mjs';
import { attempt, clearFailures, mfaFailureKey } from './rate-limit.mjs';
import { verifySecondFactor, mfaStatement, trustBrowser, confirmedFactors, ACR_MFA } from './mfa.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { notify } from '../services/notify.mjs';
// Where a finished second factor may send the person when there is no authorization request.
export const safeNext = value => typeof value === 'string' && /^\/(admin|account)(\/[A-Za-z0-9/_.-]*)?(\?[A-Za-z0-9=&%_.-]*)?$/.test(value) ? value : '/account';
function challenge(request, values, { trust, message = '' }) {
    return page('Two-factor check', `<h1>Enter your code</h1>${message ? `<p role="alert">${e(message)}</p>` : ''}
<p>Open your authenticator app and enter the six-digit code. Lost it? Enter one of your recovery codes instead.</p>
<form method="post" action="/mfa"><input type="hidden" name="csrf" value="${e(cookies(request)[CSRF_COOKIE] || '')}">
<input type="hidden" name="request_id" value="${e(values.request_id || '')}"><input type="hidden" name="next" value="${e(values.next || '')}">
<label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required autofocus>
${trust ? `<label><input type="checkbox" name="trust" value="1"> Trust this browser for ${trust} days</label>` : ''}
<button>Continue</button></form>`, { status: message ? 401 : 200 });
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
    if (request.method === 'GET') return challenge(request, values, { trust });
    await requireCsrf(request, env, session, values.csrf);
    const key = mfaFailureKey(session.user_id);
    invariant(await attempt(env, key), 'rate_limit', 'Too many attempts. Wait fifteen minutes and try again.', 429);
    const result = await verifySecondFactor(env, session.user_id, values.code);
    if (!result) return challenge(request, values, { trust, message: 'That code is not valid. Try the newest code.' });
    await clearFailures(env, key);
    await env.DB.batch([mfaStatement(env, session, result.amr),
        env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,'{}',?,?)").bind(result.kind === 'recovery' ? 'recovery_code_used' : 'mfa_verified', session.user_id, Date.now(), env.REALM.id)]);
    if (result.kind === 'recovery') notify(env, ctx, session.email, 'a recovery code was used', 'A recovery code was used to sign in. You have one fewer left; generate a new set at /account/mfa if you are running low.');
    const responseCookies = values.trust === '1' && trust ? [await trustBrowser(env, session.user_id, trust, request)] : [];
    const current = await sessionByHash(env, session.hash);
    if (pending) return completeAuthorization(env, request, pending.row.id, current, responseCookies);
    return redirect(`${env.ISSUER}${safeNext(values.next)}`, responseCookies);
}
