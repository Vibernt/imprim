import { challengeOf } from '../lib/crypto.mjs';
import { tokenShape, uniqueParams, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookie } from './session.mjs';
import { pendingRequest } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { githubProfile } from './github-profile.mjs';
import { providerStart, claimProviderState } from './provider-state.mjs';
import { completeProviderCallback } from './provider-callback.mjs';

export const OAUTH_COOKIE = '__Host-vi_oauth';
function configured(env) {
    invariant(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET, 'github_config', 'GitHub sign-in is not configured.', 503);
}
export async function githubStart(request, env) {
    const { state, browserNonce, verifier } = await providerStart(request, env, 'github', configured);
    const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.ISSUER}/auth/github/callback`,
        state, code_challenge: await challengeOf(verifier), code_challenge_method: 'S256', scope: 'read:user user:email' });
    return redirect('https://github.com/login/oauth/authorize?' + params, [cookie(OAUTH_COOKIE, browserNonce, 600)]);
}
export async function githubCallback(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams);
    invariant(tokenShape(query.state), 'invalid_grant', 'Invalid GitHub state.', 401);
    const row = await claimProviderState(env, request, 'github', OAUTH_COOKIE, query.state);
    invariant(row, 'invalid_grant', 'GitHub state expired, used, or from another browser.', 401);
    invariant(!query.error && /^[A-Za-z0-9_-]{1,200}$/.test(query.code || ''), 'invalid_grant', 'GitHub sign-in cancelled or invalid.', 401);
    const { client } = await pendingRequest(env, request, row.request_id);
    requireMethod(client, 'github'); configured(env);
    const profile = await githubProfile(env, query.code, row.verifier);
    return completeProviderCallback(request, env, row, profile, cookie(OAUTH_COOKIE, '', 0));
}
