import { randomToken, sha256 } from '../lib/crypto.mjs';
import { readBody, tokenShape, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { pendingRequest } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { assertOrigin, BROWSER_COOKIE, cookies } from './session.mjs';
import { requireLiveSignup, signupWorkspaceName } from './signup-policy.mjs';
import { realmId } from '../realms/realm.mjs';

export async function providerStart(request, env, provider, configured) {
    const signup = request.method === 'POST';
    if (signup) {
        assertOrigin(request, env);
        invariant(tokenShape(cookies(request)[BROWSER_COOKIE]), 'browser_binding', 'Open the sign-in page first.', 403);
    }
    const fields = signup ? await readBody(request, 'form') : uniqueParams(new URL(request.url).searchParams);
    const pending = await pendingRequest(env, request, fields.request_id);
    if (signup) await requireLiveSignup(env, pending);
    requireMethod(pending.client, provider);
    configured(env);
    const name = signup ? signupWorkspaceName(fields.workspace_name) : null;
    const state = randomToken(), browserNonce = randomToken(), verifier = randomToken();
    const nonce = provider === 'google' ? randomToken() : null;
    await env.DB.prepare(`INSERT INTO oauth_states(hash,browser_hash,verifier,request_id,expires_at,provider,oidc_nonce,purpose,workspace_name)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(await sha256(state), await sha256(browserNonce), verifier, pending.row.id,
        Date.now() + 600000, provider, nonce, signup ? 'signup' : 'sign_in', name).run();
    return { state, browserNonce, verifier, nonce };
}

// Both cookies must match in the atomic claim. Invalid or foreign callbacks cannot spend a usable state.
export async function claimProviderState(env, request, provider, cookieName, state) {
    const jar = cookies(request), nonce = jar[cookieName], browser = jar[BROWSER_COOKIE];
    if (!tokenShape(nonce) || !tokenShape(browser)) return null;
    return env.DB.prepare(`DELETE FROM oauth_states WHERE hash=? AND provider=? AND browser_hash=? AND expires_at>?
        AND EXISTS(SELECT 1 FROM auth_requests a JOIN clients c ON c.id=a.client_id
            WHERE a.id=oauth_states.request_id AND a.browser_hash=? AND c.realm_id=?)
        RETURNING *`).bind(await sha256(state), provider, await sha256(nonce), Date.now(), await sha256(browser), realmId(env)).first();
}
