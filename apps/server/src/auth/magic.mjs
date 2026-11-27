// Email links: neutral async delivery, hash-only tokens, explicit verification and shared session issuance.
import { readBody, json, tokenShape, redirect } from '../lib/http.mjs';
import { sha256, safeEqual } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookies, BROWSER_COOKIE, assertOrigin, issueSession } from './session.mjs';
import { requireTurnstile } from './turnstile.mjs';
import { limitEmail, limitDegradedAddress } from './rate-limit.mjs';
import { admitted, ensureUser, normalizeEmail, isAdmin, admitSession } from '../services/admission.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { audit } from '../services/audit.mjs';
import { claimMailbox } from '../services/access.mjs';
import { realmId } from '../realms/realm.mjs';
import { deliverMagicLink } from './magic-delivery.mjs';
import { requireLiveSignup, signupWorkspaceName } from './signup-policy.mjs';
import { completeOpenSignup } from '../workspaces/signup.mjs';
import { completeAdmittedProviderSignup } from '../workspaces/signup-account.mjs';
import { submitSignupApproval } from '../workspaces/signup-requests.mjs';
import { checkEmailCookie } from './check-email-state.mjs';
import { canSignInForWorkspaceJoin } from '../workspaces/join-policy.mjs';

export async function requestMagic(request, env, ctx) {
    assertOrigin(request, env);
    const body = await readBody(request), email = normalizeEmail(body.email);
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(browser), 'browser_binding', 'Open the sign-in page first.', 403);
    const pending = body.request_id ? await pendingRequest(env, request, body.request_id) : null;
    // 'password' links prove the mailbox before setting or resetting a password, for apps that offer passwords.
    const purpose = body.purpose === 'signup' || body.purpose === 'password' ? body.purpose : 'sign_in';
    if (purpose === 'signup') await requireLiveSignup(env, pending);
    if (purpose === 'password') invariant(pending, 'invalid_request', 'Password setup starts from an app.');
    if (pending) requireMethod(pending.client, purpose === 'password' ? 'password' : 'email');
    const name = purpose === 'signup' ? signupWorkspaceName(body.workspace_name) : null;
    invariant(env.EMAIL?.send && env.EMAIL_FROM, 'email_config', 'Transactional email is not configured.', 503);
    const challenge = await requireTurnstile(env, body.turnstile, request);
    if (challenge.mode === 'degraded') {
        await audit(env, 'turnstile_degraded', null, { action: purpose === 'signup' ? 'signup' : 'sign_in' });
        invariant(await limitDegradedAddress(env, request), 'rate_limit', 'Too many requests.', 429);
    }
    // Return before admission and delivery so eligible/ineligible addresses have the same public response path.
    ctx.waitUntil(deliverMagic(env, request, email, browser, pending, challenge.mode, purpose, name).catch(async error => {
        console.error(JSON.stringify({ type: 'magic_delivery_failed', code: error.code || 'delivery_failed' }));
        await audit(env, 'magic_delivery_failed', null, { code: error.code || 'delivery_failed' });
    }));
    return json({ accepted: true }, purpose === 'signup' ? 202 : 200, body.browser_page === true
        ? { 'set-cookie': checkEmailCookie(pending?.row.id || '', body.email) } : {});
}
async function deliverMagic(env, request, email, browser, pending, challengeMode, purpose, name) {
    if (!await limitEmail(env, email, request, challengeMode === 'degraded')) return;
    if (!pending && !await isAdmin(env, email)) return;
    if (challengeMode === 'degraded') {
        const existing = await env.DB.prepare("SELECT id FROM users WHERE realm_id=? AND email=? AND status='active' AND merged_into IS NULL").bind(realmId(env), email).first();
        if (!existing) return;
    }
    const allowed = await admitted(env, pending?.client, email);
    if (purpose === 'signup' && allowed) purpose = 'sign_in';
    if (!allowed && !(purpose === 'sign_in' && await canSignInForWorkspaceJoin(env, pending, { email }))) {
        if (purpose !== 'signup' || challengeMode === 'degraded') return;
        const unavailable = await env.DB.prepare(`SELECT 1 FROM users WHERE realm_id=? AND email=?
            AND (status<>'active' OR merged_into IS NOT NULL)`).bind(realmId(env), email).first();
        if (unavailable) return;
    }
    await deliverMagicLink(env, pending, await sha256(browser), {
        email, purpose, workspace_name: purpose === 'signup' ? name : null
    });
}
export async function verifyMagic(request, env, ctx) {
    assertOrigin(request, env);
    const { token, browser_response } = await readBody(request), browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(token) && tokenShape(browser), 'invalid_grant', 'Invalid sign-in link.', 401);
    // Matching browser is part of the atomic claim; a foreign browser cannot consume the original request.
    const row = await env.DB.prepare('DELETE FROM magic_links WHERE hash=? AND browser_hash=? AND expires_at>? AND realm_id=? RETURNING *')
        .bind(await sha256(token), await sha256(browser), Date.now(), realmId(env)).first();
    invariant(row && await safeEqual(row.browser_hash, await sha256(browser)), 'invalid_grant', 'Link is expired, used, or belongs to another browser.', 401);
    const pending = row.request_id ? await pendingRequest(env, request, row.request_id) : null;
    if (pending) requireMethod(pending.client, row.purpose === 'password' ? 'password' : 'email');
    let user;
    if (row.purpose === 'signup') {
        const mode = await requireLiveSignup(env, pending);
        if (row.provider) requireMethod(pending.client, row.provider);
        if (row.provider && await admitted(env, pending.client, row.email)) {
            user = await completeAdmittedProviderSignup(env, pending, row, mode);
        } else if (mode === 'approval') {
            const location = await submitSignupApproval(env, ctx, pending, row);
            return browser_response ? json({ redirect: location }) : redirect(location);
        } else {
            user = await completeOpenSignup(env, pending, row);
        }
    } else {
        user = await verifiedUser(env, pending, row);
    }
    const signed = await issueSession(env, user, 'email', null, !pending);
    await audit(env, 'sign_in', user.id, { method: 'email' });
    // A 'password' link is mailbox proof: record the admission now, so a domain-admitted newcomer stays admitted when
    // the sign-in continues as a password session (which is not mailbox proof).
    if (row.purpose === 'password' && pending) await admitSession(env, pending.client, signed.session);
    const response = row.purpose === 'password'
        ? redirect(`${env.ISSUER}/account/password?request_id=${encodeURIComponent(row.request_id)}`, signed.cookies)
        : pending ? await completeAuthorization(env, request, row.request_id, signed.session, signed.cookies)
        : redirect(`${env.ISSUER}/signed-in`, signed.cookies);
    if (!browser_response) return response;
    const result = json({ redirect: response.headers.get('location') });
    for (const value of signed.cookies) result.headers.append('set-cookie', value);
    return result;
}

async function verifiedUser(env, pending, row) {
    invariant(await admitted(env, pending?.client, row.email) ||
        (row.purpose === 'sign_in' && await canSignInForWorkspaceJoin(env, pending, { email: row.email })),
        'access_denied', 'Account unavailable.', 403);
    const existing = await env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realmId(env), row.email).first();
    if (existing?.status === 'active' && !existing.merged_into) await claimMailbox(env, existing);
    return ensureUser(env, row.email);
}
