// Assay magic.mjs: neutral async delivery, hash-only tokens, explicit verification and shared session issuance.
import { readBody, json, tokenShape, redirect } from '../lib/http.mjs';
import { randomToken, sha256, safeEqual } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookies, BROWSER_COOKIE, assertOrigin, issueSession } from './session.mjs';
import { requireTurnstile } from './turnstile.mjs';
import { limitEmail, limitDegradedAddress } from './rate-limit.mjs';
import { admitted, ensureUser, normalizeEmail, isAdmin } from '../services/admission.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { audit } from '../services/audit.mjs';
import { claimMailbox } from '../services/access.mjs';
import { realmId } from '../realms/realm.mjs';
export async function requestMagic(request, env, ctx) {
    assertOrigin(request, env);
    const body = await readBody(request), email = normalizeEmail(body.email);
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(browser), 'browser_binding', 'Open the sign-in page first.', 403);
    const pending = body.request_id ? await pendingRequest(env, request, body.request_id) : null;
    // 'password' links prove the mailbox before setting or resetting a password, for apps that offer passwords.
    const purpose = body.purpose === 'password' ? 'password' : 'sign_in';
    invariant(purpose === 'sign_in' || pending, 'invalid_request', 'Password setup starts from an app.');
    if (pending) requireMethod(pending.client, purpose === 'password' ? 'password' : 'email');
    invariant(env.EMAIL?.send && env.EMAIL_FROM, 'email_config', 'Transactional email is not configured.', 503);
    const challenge = await requireTurnstile(env, body.turnstile, request);
    if (challenge.mode === 'degraded') {
        await audit(env, 'turnstile_degraded', null, { action: 'sign_in' });
        invariant(await limitDegradedAddress(env, request), 'rate_limit', 'Too many requests.', 429);
    }
    // Return before admission and delivery so eligible/ineligible addresses have the same public response path.
    ctx.waitUntil(deliverMagic(env, request, email, browser, pending, challenge.mode, purpose).catch(async error => {
        console.error(JSON.stringify({ type: 'magic_delivery_failed', code: error.code || 'delivery_failed' }));
        await audit(env, 'magic_delivery_failed', null, { code: error.code || 'delivery_failed' });
    }));
    return json({ accepted: true });
}
async function deliverMagic(env, request, email, browser, pending, challengeMode, purpose = 'sign_in') {
    if (!await limitEmail(env, email, request, challengeMode === 'degraded')) return;
    if (!pending && !await isAdmin(env, email)) return;
    if (challengeMode === 'degraded') {
        const existing = await env.DB.prepare("SELECT id FROM users WHERE realm_id=? AND email=? AND status='active' AND merged_into IS NULL").bind(realmId(env), email).first();
        if (!existing) return;
    }
    if (!await admitted(env, pending?.client, email)) return;
    const token = randomToken(), hash = await sha256(token);
    await env.DB.prepare('INSERT INTO magic_links(hash,email,request_id,browser_hash,expires_at,realm_id,purpose) VALUES(?,?,?,?,?,?,?)')
        .bind(hash, email, pending?.row.id || null, await sha256(browser), Date.now() + 900000, realmId(env), purpose).run();
    const link = `${env.ISSUER}/login#token=${token}`;
    try {
        const name = (pending && JSON.parse(pending.client.branding).name) || env.REALM.display_name;
        const subject = purpose === 'password' ? `Set your password for ${name}` : `Sign in to ${name}`;
        const action = purpose === 'password' ? 'choose Continue, then set your password' : 'choose Sign in';
        await env.EMAIL.send({ from: env.EMAIL_FROM, to: email, subject,
            text: `Open this link in the browser where you started, then ${action}. It expires in 15 minutes.\n\n${link}\n\nIgnore this email if you did not request it.` });
    } catch (error) {
        await env.DB.prepare('DELETE FROM magic_links WHERE hash=?').bind(hash).run();
        throw error;
    }
}
export async function verifyMagic(request, env) {
    assertOrigin(request, env);
    const { token, browser_response } = await readBody(request), browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(token) && tokenShape(browser), 'invalid_grant', 'Invalid sign-in link.', 401);
    // Matching browser is part of the atomic claim; a foreign browser cannot consume the original request.
    const row = await env.DB.prepare('DELETE FROM magic_links WHERE hash=? AND browser_hash=? AND expires_at>? AND realm_id=? RETURNING *')
        .bind(await sha256(token), await sha256(browser), Date.now(), realmId(env)).first();
    invariant(row && await safeEqual(row.browser_hash, await sha256(browser)), 'invalid_grant', 'Link is expired, used, or belongs to another browser.', 401);
    const pending = row.request_id ? await pendingRequest(env, request, row.request_id) : null;
    if (pending) requireMethod(pending.client, row.purpose === 'password' ? 'password' : 'email');
    invariant(pending || await isAdmin(env, row.email), 'access_denied', 'Account unavailable.', 403);
    invariant(await admitted(env, pending?.client, row.email), 'access_denied', 'Account unavailable.', 403);
    const existing = await env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realmId(env), row.email).first();
    if (existing?.status === 'active' && !existing.merged_into) await claimMailbox(env, existing);
    const user = await ensureUser(env, row.email), signed = await issueSession(env, user, 'email', null, !pending);
    await audit(env, 'sign_in', user.id, { method: 'email' });
    const response = row.purpose === 'password'
        ? redirect(`${env.ISSUER}/account/password?request_id=${encodeURIComponent(row.request_id)}`, signed.cookies)
        : pending ? await completeAuthorization(env, request, row.request_id, signed.session, signed.cookies)
        : redirect(`${env.ISSUER}/signed-in`, signed.cookies);
    if (!browser_response) return response;
    const result = json({ redirect: response.headers.get('location') });
    for (const value of signed.cookies) result.headers.append('set-cookie', value);
    return result;
}
