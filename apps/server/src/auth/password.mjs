// Email-and-password sign-in. The same generic error covers an unknown email, a missing password and a wrong one,
// and the same key derivation runs in every case.
import { readBody, json, tokenShape } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookies, BROWSER_COOKIE, assertOrigin, issueSession } from './session.mjs';
import { requireTurnstile } from './turnstile.mjs';
import { limitDegradedAddress, attempt, clearFailures, passwordKey } from './rate-limit.mjs';
import { verifyPassword, needsRehash, hashPassword } from './password-hash.mjs';
import { admitted, normalizeEmail, isAdmin } from '../services/admission.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { audit } from '../services/audit.mjs';
import { realmId } from '../realms/realm.mjs';
import { canSignInForWorkspaceJoin } from '../workspaces/join-policy.mjs';
const WRONG = 'Email or password is incorrect.';
export async function passwordSignIn(request, env) {
    assertOrigin(request, env);
    const body = await readBody(request), email = normalizeEmail(body.email);
    invariant(typeof body.password === 'string' && body.password.length > 0 && body.password.length <= 1024, 'invalid_request', 'Enter your password.');
    invariant(tokenShape(cookies(request)[BROWSER_COOKIE]), 'browser_binding', 'Open the sign-in page first.', 403);
    // Administrators sign in with email links only; password sign-in always starts from an app.
    invariant(typeof body.request_id === 'string', 'invalid_request', 'Password sign-in starts from an app.');
    const pending = await pendingRequest(env, request, body.request_id);
    requireMethod(pending.client, 'password');
    const challenge = await requireTurnstile(env, body.turnstile, request);
    if (challenge.mode === 'degraded') invariant(await limitDegradedAddress(env, request), 'rate_limit', 'Too many requests.', 429);
    const key = await passwordKey(env, email);
    invariant(await attempt(env, key), 'rate_limit', 'Too many attempts for this account. Wait fifteen minutes, or sign in with an email link.', 429);
    // One query whether or not the account or its password exists, so timing reveals neither.
    const found = await env.DB.prepare(`SELECT u.*,p.algorithm,p.iterations,p.salt,p.hash AS password_hash FROM users u
        LEFT JOIN user_passwords p ON p.user_id=u.id WHERE u.realm_id=? AND u.email=? AND u.status='active' AND u.merged_into IS NULL`).bind(realmId(env), email).first();
    const stored = found?.password_hash ? { algorithm: found.algorithm, iterations: found.iterations, salt: found.salt, hash: found.password_hash } : null;
    const user = found;
    const valid = await verifyPassword(body.password, stored) && !await isAdmin(env, email);
    if (!valid) {
        await audit(env, 'password_failed', user?.id ?? null, {});
        invariant(false, 'invalid_grant', WRONG, 401);
    }
    await clearFailures(env, key);
    // A password proves knowledge, not current control of the mailbox, so domain rules do not admit by it.
    invariant(await admitted(env, pending.client, email, 'provider') ||
        await canSignInForWorkspaceJoin(env, pending, { userId: user.id }), 'access_denied', 'Account unavailable.', 403);
    if (needsRehash(stored)) {
        const next = await hashPassword(body.password);
        await env.DB.prepare('UPDATE user_passwords SET algorithm=?,iterations=?,salt=?,hash=?,updated=? WHERE user_id=? AND hash=?')
            .bind(next.algorithm, next.iterations, next.salt, next.hash, Date.now(), user.id, stored.hash).run();
    }
    const signed = await issueSession(env, user, 'password');
    await audit(env, 'sign_in', user.id, { method: 'password' });
    const response = await completeAuthorization(env, request, pending.row.id, signed.session, signed.cookies);
    const result = json({ redirect: response.headers.get('location') });
    for (const value of response.headers.getSetCookie()) result.headers.append('set-cookie', value);
    return result;
}
