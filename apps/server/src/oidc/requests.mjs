import { validateAgentRequest } from '../agents/authorize.mjs';
import { cookies, BROWSER_COOKIE } from '../auth/session.mjs';
import { sha256, safeEqual, randomToken } from '../lib/crypto.mjs';
import { AppError, invariant } from '../lib/errors.mjs';
import { redirect } from '../lib/http.mjs';
import { getClient, registeredUri } from './clients.mjs';
import { requireMethod } from './sign-in-methods.mjs';
import { sessionByHash } from '../auth/session.mjs';
import { admitSession, admissionGuard } from '../services/admission.mjs';
import { mfaGate } from '../auth/mfa.mjs';
import { useLocale } from '../i18n/index.mjs';
import { offerWorkspaceJoin } from '../workspaces/join-policy.mjs';
// max_age is whole seconds since auth_time, which is itself whole seconds (OIDC Core 3.1.2.1). Comparing the rounded
// auth_time with the clock in milliseconds would refuse a sign-in made late in a second, one second too soon.
export const withinMaxAge = (authTime, maxAge, now = Date.now()) => Math.floor(now / 1000) - authTime <= maxAge;
export async function pendingRequest(env, request, id) {
    invariant(typeof id === 'string' && id.length <= 100, 'invalid_request', 'Authorization request required.');
    const row = await env.DB.prepare('SELECT * FROM auth_requests WHERE id=? AND expires_at>?').bind(id, Date.now()).first();
    const browser = cookies(request)[BROWSER_COOKIE];
    // A page that stops later in this request offers the way back: the app (from another browser too) and, in the
    // browser that started it, this sign-in itself (pages/next-steps.mjs).
    if (row) env.SIGN_IN = { app: row.client_id };
    invariant(row && browser && await safeEqual(await sha256(browser), row.browser_hash), 'browser_binding', 'Sign-in must finish in the browser that started it.', 403);
    const client = await getClient(env, row.client_id);
    env.SIGN_IN = { app: client.id, id: row.id };
    useLocale(env, { client, uiLocales: row.ui_locales });
    if (row.agent_client_id) await validateAgentRequest(env, row);
    else registeredUri(client, row.redirect_uri);
    return { row, client };
}
export function authorizationResponse(env, row, values, responseCookies = []) {
    const url = new URL(row.redirect_uri);
    for (const [key, value] of Object.entries({ ...values, state: row.state, iss: env.ISSUER })) url.searchParams.set(key, value);
    return redirect(url.href, responseCookies);
}
export function requireAuthorizationSession(row, session) {
    // prompt=login and max_age hold however the sign-in continues (the MFA and set-password pages included): the
    // session must be newer than the request, or than max_age.
    const created = row.expires_at - 1800000, authMs = session.auth_time * 1000;
    invariant(row.prompt !== 'login' || authMs >= created - 1000, 'login_required', 'This app asked for a fresh sign-in. Sign in again.', 401);
    invariant(row.max_age == null || withinMaxAge(session.auth_time, row.max_age), 'login_required', 'This app asked for a recent sign-in. Sign in again.', 401);
    // An id_token_hint named the person this app expects; nobody else may finish the request.
    invariant(row.hint_sub == null || row.hint_sub === session.user_id, 'login_required', 'This app asked for a different account. Sign in as that person.', 401);
    invariant(!row.workspace_join || JSON.parse(row.workspace_join).user_id === session.user_id,
        'access_denied', 'This sign-in request belongs to another account.', 403);
}
export async function completeAuthorization(env, request, id, session, responseCookies = [], { interactive = true } = {}) {
    const pending = await pendingRequest(env, request, id);
    const { row, client } = pending;
    requireMethod(client, session.method, session.google_hd, true);
    invariant(await sessionByHash(env, session.hash), 'access_denied', 'Account unavailable.', 403);
    requireAuthorizationSession(row, session);
    try {
        await admitSession(env, client, session);
    } catch (error) {
        if (interactive && error instanceof AppError && error.code === 'access_denied' &&
            await offerWorkspaceJoin(env, pending, session.user_id)) {
            return redirect(`${env.ISSUER}/workspace-join?request_id=${encodeURIComponent(row.id)}`, responseCookies);
        }
        throw error;
    }
    // The second factor sits in front of every code and every agent consent.
    const gate = await mfaGate(env, request, { client, session, row, agent: Boolean(row.agent_client_id) });
    if (gate) {
        invariant(interactive, 'interaction_required', 'A second factor is required.');
        return redirect(`${env.ISSUER}${gate}`, responseCookies);
    }
    if (row.agent_client_id) {
        await validateAgentRequest(env, row, session);
        return redirect(`${env.ISSUER}/agent/consent?request_id=${row.id}`, responseCookies);
    }
    const code = randomToken(), hash = await sha256(code), now = Date.now(), admission = admissionGuard('s.user_id', client.id);
    // Both statements execute as one D1 transaction. Concurrent completions can mint only one code.
    const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO codes(hash,client_id,redirect_uri,challenge,nonce,scope,session_hash,expires_at)
            SELECT ?,client_id,redirect_uri,challenge,nonce,scope,?,? FROM auth_requests
            WHERE id=? AND browser_hash=? AND expires_at>?
            AND (workspace_join IS NULL OR json_extract(workspace_join,'$.user_id')=?)
            AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
                WHERE s.hash=? AND s.expires_at>? AND u.status='active' AND u.merged_into IS NULL AND ${admission.sql})`)
            .bind(hash, session.hash, now + 60000, id, row.browser_hash, now, session.user_id, session.hash, now, ...admission.args),
        env.DB.prepare('DELETE FROM auth_requests WHERE id=? AND EXISTS(SELECT 1 FROM codes WHERE hash=?)').bind(id, hash)
    ]);
    invariant(results[0].meta.changes === 1, 'invalid_request', 'Authorization request already completed.');
    return authorizationResponse(env, row, { code }, responseCookies);
}
