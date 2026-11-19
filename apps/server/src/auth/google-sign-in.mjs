import { randomToken, sha256, challengeOf, safeEqual } from '../lib/crypto.mjs';
import { tokenShape, uniqueParams, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookie, cookies, issueSession, getSession } from './session.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { googleProfile } from './google-token.mjs';
import { providerIdentity } from './provider-identity.mjs';
import { audit } from '../services/audit.mjs';
export const GOOGLE_COOKIE = '__Host-vi_google';
function configured(env) {
    invariant(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET, 'google_config', 'Google sign-in is not configured.', 503);
}
export async function googleStart(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams);
    const { row, client } = await pendingRequest(env, request, query.request_id);
    requireMethod(client, 'google'); configured(env);
    const state = randomToken(), browserNonce = randomToken(), verifier = randomToken(), nonce = randomToken();
    await env.DB.prepare(`INSERT INTO oauth_states(hash,browser_hash,verifier,request_id,expires_at,provider,oidc_nonce) VALUES(?,?,?,?,?,'google',?)`)
        .bind(await sha256(state), await sha256(browserNonce), verifier, row.id, Date.now() + 600000, nonce).run();
    const params = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.ISSUER}/login/google/callback`,
        response_type: 'code', scope: 'openid email', state, nonce, code_challenge: await challengeOf(verifier), code_challenge_method: 'S256' });
    return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params, [cookie(GOOGLE_COOKIE, browserNonce, 600)]);
}
export async function googleCallback(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams), browserNonce = cookies(request)[GOOGLE_COOKIE];
    invariant(tokenShape(query.state), 'invalid_grant', 'Invalid Google state.', 401);
    const row = await env.DB.prepare("DELETE FROM oauth_states WHERE hash=? AND provider='google' RETURNING *").bind(await sha256(query.state)).first();
    invariant(row && tokenShape(browserNonce) && row.expires_at > Date.now() && await safeEqual(await sha256(browserNonce), row.browser_hash),
        'invalid_grant', 'Google state expired, used, or from another browser.', 401);
    invariant(!query.error && typeof query.code === 'string' && /^[\x21-\x7e]{1,2048}$/.test(query.code), 'invalid_grant', 'Google sign-in cancelled or invalid.', 401);
    const { client } = await pendingRequest(env, request, row.request_id);
    requireMethod(client, 'google'); configured(env);
    const profile = await googleProfile(env, query.code, row.verifier, row.oidc_nonce);
    // Re-read current policy after network I/O, before linking or issuing any session.
    const current = await pendingRequest(env, request, row.request_id);
    requireMethod(current.client, 'google', profile.hd, true);
    const user = await providerIdentity(env, current.client, 'google', profile, await getSession(request, env), current);
    const signed = await issueSession(env, user, 'google', profile.hd);
    await audit(env, 'sign_in', user.id, { method: 'google' });
    return completeAuthorization(env, request, row.request_id, signed.session, [...signed.cookies, cookie(GOOGLE_COOKIE, '', 0)]);
}
