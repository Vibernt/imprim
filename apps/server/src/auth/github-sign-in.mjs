// Ported from Assay: PKCE S256, browser nonce, hashed single-use state, no network within D1 transactions.
import { randomToken, sha256, challengeOf, safeEqual } from '../lib/crypto.mjs';
import { tokenShape, uniqueParams, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookie, cookies, issueSession, getSession } from './session.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { githubProfile } from './github-profile.mjs';
import { githubIdentity } from './github-identity.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { audit } from '../services/audit.mjs';
export const OAUTH_COOKIE = '__Host-vi_oauth';
function configured(env) {
    invariant(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET, 'github_config', 'GitHub sign-in is not configured.', 503);
}
export async function githubStart(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams);
    const { row, client } = await pendingRequest(env, request, query.request_id);
    requireMethod(client, 'github'); configured(env);
    const state = randomToken(), nonce = randomToken(), verifier = randomToken();
    await env.DB.prepare('INSERT INTO oauth_states(hash,browser_hash,verifier,request_id,expires_at) VALUES(?,?,?,?,?)')
        .bind(await sha256(state), await sha256(nonce), verifier, row.id, Date.now() + 600000).run();
    const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.ISSUER}/auth/github/callback`,
        state, code_challenge: await challengeOf(verifier), code_challenge_method: 'S256', scope: 'read:user user:email' });
    return redirect('https://github.com/login/oauth/authorize?' + params, [cookie(OAUTH_COOKIE, nonce, 600)]);
}
export async function githubCallback(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams), nonce = cookies(request)[OAUTH_COOKIE];
    invariant(tokenShape(query.state), 'invalid_grant', 'Invalid GitHub state.', 401);
    const row = await env.DB.prepare("DELETE FROM oauth_states WHERE hash=? AND provider='github' RETURNING *").bind(await sha256(query.state)).first();
    invariant(row && tokenShape(nonce) && row.expires_at > Date.now() && await safeEqual(await sha256(nonce), row.browser_hash), 'invalid_grant', 'GitHub state expired, used, or from another browser.', 401);
    invariant(!query.error && /^[A-Za-z0-9_-]{1,200}$/.test(query.code || ''), 'invalid_grant', 'GitHub sign-in cancelled or invalid.', 401);
    const { client } = await pendingRequest(env, request, row.request_id);
    requireMethod(client, 'github'); configured(env);
    const profile = await githubProfile(env, query.code, row.verifier);
    const current = await pendingRequest(env, request, row.request_id);
    requireMethod(current.client, 'github');
    const user = await githubIdentity(env, current.client, profile, await getSession(request, env)), signed = await issueSession(env, user, 'github');
    await audit(env, 'sign_in', user.id, { method: 'github' });
    return completeAuthorization(env, request, row.request_id, signed.session, [...signed.cookies, cookie(OAUTH_COOKIE, '', 0)]);
}
