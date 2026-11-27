import { challengeOf } from '../lib/crypto.mjs';
import { tokenShape, uniqueParams, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookie } from './session.mjs';
import { pendingRequest } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { googleProfile } from './google-token.mjs';
import { providerStart, claimProviderState } from './provider-state.mjs';
import { completeProviderCallback } from './provider-callback.mjs';

export const GOOGLE_COOKIE = '__Host-vi_google';
function configured(env) {
    invariant(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET, 'google_config', 'Google sign-in is not configured.', 503);
}
export async function googleStart(request, env) {
    const { state, browserNonce, verifier, nonce } = await providerStart(request, env, 'google', configured);
    const params = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.ISSUER}/login/google/callback`,
        response_type: 'code', scope: 'openid email', state, nonce, code_challenge: await challengeOf(verifier), code_challenge_method: 'S256' });
    return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params, [cookie(GOOGLE_COOKIE, browserNonce, 600)]);
}
export async function googleCallback(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams);
    invariant(tokenShape(query.state), 'invalid_grant', 'Invalid Google state.', 401);
    const row = await claimProviderState(env, request, 'google', GOOGLE_COOKIE, query.state);
    invariant(row, 'invalid_grant', 'Google state expired, used, or from another browser.', 401);
    invariant(!query.error && typeof query.code === 'string' && /^[\x21-\x7e]{1,2048}$/.test(query.code), 'invalid_grant', 'Google sign-in cancelled or invalid.', 401);
    const { client } = await pendingRequest(env, request, row.request_id);
    requireMethod(client, 'google'); configured(env);
    const profile = await googleProfile(env, query.code, row.verifier, row.oidc_nonce);
    return completeProviderCallback(request, env, row, profile, cookie(GOOGLE_COOKIE, '', 0));
}
