import { validateAgentRequest } from '../agents/authorize.mjs';
import { cookies, BROWSER_COOKIE } from '../auth/session.mjs';
import { sha256, safeEqual, randomToken } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
import { redirect } from '../lib/http.mjs';
import { getClient, registeredUri } from './clients.mjs';
import { requireMethod } from './sign-in-methods.mjs';
import { sessionByHash } from '../auth/session.mjs';
import { admitSession, admissionGuard } from '../services/admission.mjs';
import { mfaGate } from '../auth/mfa.mjs';
import { useLocale } from '../i18n/index.mjs';
export async function pendingRequest(env, request, id) {
    invariant(typeof id === 'string' && id.length <= 100, 'invalid_request', 'Authorization request required.');
    const row = await env.DB.prepare('SELECT * FROM auth_requests WHERE id=? AND expires_at>?').bind(id, Date.now()).first();
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(row && browser && await safeEqual(await sha256(browser), row.browser_hash), 'browser_binding', 'Sign-in must finish in the browser that started it.', 403);
    const client = await getClient(env, row.client_id);
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
export async function completeAuthorization(env, request, id, session, responseCookies = [], { interactive = true } = {}) {
    const { row, client } = await pendingRequest(env, request, id);
    requireMethod(client, session.method, session.google_hd, true);
    invariant(await sessionByHash(env, session.hash), 'access_denied', 'Account unavailable.', 403);
    // prompt=login and max_age hold however the sign-in continues (the MFA and set-password pages included): the
    // session must be newer than the request, or than max_age.
    const created = row.expires_at - 1800000, authMs = session.auth_time * 1000;
    invariant(row.prompt !== 'login' || authMs >= created - 1000, 'login_required', 'This app asked for a fresh sign-in. Sign in again.', 401);
    invariant(row.max_age == null || authMs >= Date.now() - row.max_age * 1000, 'login_required', 'This app asked for a recent sign-in. Sign in again.', 401);
    await admitSession(env, client, session);
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
            AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
                WHERE s.hash=? AND s.expires_at>? AND u.status='active' AND u.merged_into IS NULL AND ${admission.sql})`)
            .bind(hash, session.hash, now + 60000, id, row.browser_hash, now, session.hash, now, ...admission.args),
        env.DB.prepare('DELETE FROM auth_requests WHERE id=? AND EXISTS(SELECT 1 FROM codes WHERE hash=?)').bind(id, hash)
    ]);
    invariant(results[0].meta.changes === 1, 'invalid_request', 'Authorization request already completed.');
    return authorizationResponse(env, row, { code }, responseCookies);
}
