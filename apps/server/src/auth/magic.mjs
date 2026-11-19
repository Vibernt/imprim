// Email links: neutral async delivery, hash-only tokens, explicit verification and shared session issuance.
import { readBody, json, tokenShape, redirect } from '../lib/http.mjs';
import { randomToken, sha256, safeEqual } from '../lib/crypto.mjs';
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
import { brandingFor } from '../branding/tokens.mjs';
import { sendEmail } from '../services/email/send.mjs';
import { liveSignupEnabled, liveSignupMode, requireSignup, signupOff, signupWorkspaceName } from './signup-policy.mjs';
import { completeOpenSignup } from '../workspaces/signup.mjs';
import { recordSignupRequest } from '../workspaces/signup-requests.mjs';
import { notifySignupAdmins } from '../workspaces/signup-email.mjs';
const linkKinds = { sign_in: 'sign_in_link', password: 'password_link', signup: 'signup_link' };

export async function requestMagic(request, env, ctx) {
    assertOrigin(request, env);
    const body = await readBody(request), email = normalizeEmail(body.email);
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(browser), 'browser_binding', 'Open the sign-in page first.', 403);
    const pending = body.request_id ? await pendingRequest(env, request, body.request_id) : null;
    // 'password' links prove the mailbox before setting or resetting a password, for apps that offer passwords.
    const purpose = body.purpose === 'signup' || body.purpose === 'password' ? body.purpose : 'sign_in';
    if (purpose === 'signup') {
        requireSignup(env, pending);
        invariant(await liveSignupEnabled(env, pending.client), 'access_denied', signupOff, 403);
    }
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
    return json({ accepted: true }, purpose === 'signup' ? 202 : 200);
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
    if (!allowed) {
        if (purpose !== 'signup' || challengeMode === 'degraded') return;
        const unavailable = await env.DB.prepare(`SELECT 1 FROM users WHERE realm_id=? AND email=?
            AND (status<>'active' OR merged_into IS NOT NULL)`).bind(realmId(env), email).first();
        if (unavailable) return;
    }
    const token = randomToken(), hash = await sha256(token);
    await env.DB.prepare('INSERT INTO magic_links(hash,email,request_id,browser_hash,expires_at,realm_id,purpose,workspace_name) VALUES(?,?,?,?,?,?,?,?)')
        .bind(hash, email, pending?.row.id || null, await sha256(browser), Date.now() + 900000, realmId(env), purpose, purpose === 'signup' ? name : null).run();
    const link = `${env.ISSUER}/login#token=${token}`;
    try {
        // The app's brand, in the language of the sign-in page that asked (its ui_locales, the browser's, the brand's).
        await sendEmail(env, { kind: linkKinds[purpose], to: email, branding: brandingFor(env, pending?.client), links: { link } });
    } catch (error) {
        await env.DB.prepare('DELETE FROM magic_links WHERE hash=?').bind(hash).run();
        throw error;
    }
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
    if (row.purpose === 'signup') {
        requireSignup(env, pending);
        const mode = await liveSignupMode(env, pending.client);
        invariant(mode !== 'off', 'access_denied', signupOff, 403);
        if (mode === 'approval') {
            const saved = await recordSignupRequest(env, pending, row);
            if (saved) ctx.waitUntil(notifySignupAdmins(env, pending.client, saved));
            const location = `${env.ISSUER}/signup-pending?request_id=${encodeURIComponent(pending.row.id)}`;
            return browser_response ? json({ redirect: location }) : redirect(location);
        }
    }
    const user = row.purpose === 'signup' ? await completeOpenSignup(env, pending, row) : await verifiedUser(env, pending, row);
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
    invariant(await admitted(env, pending?.client, row.email), 'access_denied', 'Account unavailable.', 403);
    const existing = await env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realmId(env), row.email).first();
    if (existing?.status === 'active' && !existing.merged_into) await claimMailbox(env, existing);
    return ensureUser(env, row.email);
}
