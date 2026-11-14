import { authorizeAgent } from '../agents/authorize.mjs';
import { getClient, registeredUri } from './clients.mjs';
import { invariant, AppError } from '../lib/errors.mjs';
const oauthErrors = new Set(['invalid_request', 'access_denied', 'login_required', 'interaction_required', 'consent_required']);
import { uniqueParams, tokenShape } from '../lib/http.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { getSession, cookie, cookies, BROWSER_COOKIE } from '../auth/session.mjs';
import { authorizationResponse, completeAuthorization } from './requests.mjs';
import { allowsMethod } from './sign-in-methods.mjs';
import { signInPage } from '../pages/sign-in.mjs';
export async function authorize(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams);
    if (query.resource !== undefined || query.client_id?.startsWith('https://') || query.client_id?.startsWith('agent_')) return authorizeAgent(request, env, query);
    const client = await getClient(env, query.client_id);
    registeredUri(client, query.redirect_uri); // Never redirect errors until this boundary is trusted.
    try {
        invariant(query.response_type === 'code', 'unsupported_response_type', 'Only code is supported.');
        invariant(query.code_challenge_method === 'S256' && tokenShape(query.code_challenge), 'invalid_request', 'PKCE S256 required.');
        for (const name of ['state', 'nonce']) invariant(typeof query[name] === 'string' && query[name].length > 0 && query[name].length <= 512, 'invalid_request', `${name} required.`);
        const scopes = (query.scope || '').split(' ');
        invariant(scopes.includes('openid') && scopes.every(s => ['openid', 'email', 'profile'].includes(s)), 'invalid_scope', 'Use openid, email and/or profile scopes.');
        invariant(query.prompt === undefined || ['none', 'login'].includes(query.prompt), 'invalid_request', 'Unsupported prompt.');
        invariant(!query.response_mode || query.response_mode === 'query', 'invalid_request', 'Only query response mode supported.');
        invariant(query.max_age === undefined || /^\d{1,9}$/.test(query.max_age), 'invalid_request', 'max_age must be whole seconds.');
        invariant(query.acr_values === undefined || (query.acr_values.length <= 512 && /^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(query.acr_values)), 'invalid_request', 'Invalid acr_values.');
        for (const name of ['request', 'request_uri', 'claims', 'id_token_hint'])
            invariant(query[name] === undefined, 'invalid_request', `${name} is not supported in M1.`);
    } catch (error) {
        if (!error.code) throw error;
        return authorizationResponse(env, { ...query, state: query.state || '' }, { error: error.code });
    }
    let session = query.prompt === 'login' ? null : await getSession(request, env);
    // max_age: an older primary sign-in counts as no sign-in (OIDC Core 3.1.2.1).
    if (session && query.max_age !== undefined && session.auth_time + Number(query.max_age) < Math.floor(Date.now() / 1000)) session = null;
    if (session && !allowsMethod(client, session.method, session.google_hd, true)) session = null;
    if (!session && query.prompt === 'none') return authorizationResponse(env, query, { error: 'login_required' });
    const existing = cookies(request)[BROWSER_COOKIE];
    const browser = tokenShape(existing) ? existing : randomToken(), id = randomToken();
    const responseCookies = [cookie(BROWSER_COOKIE, browser, 1800)];
    await env.DB.prepare(`INSERT INTO auth_requests(id,client_id,redirect_uri,state,nonce,challenge,scope,browser_hash,expires_at,acr_values,max_age)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id, client.id, query.redirect_uri, query.state, query.nonce,
            query.code_challenge, query.scope, await sha256(browser), Date.now() + 1800000, query.acr_values ?? null, query.max_age === undefined ? null : Number(query.max_age)).run();
    if (session) {
        // Carry the just-created binding internally for immediate SSO; never trust a caller-supplied request id.
        const headers = new Headers(request.headers);
        headers.set('cookie', `${BROWSER_COOKIE}=${browser}`);
        try { return await completeAuthorization(env, new Request(request, { headers }), id, session, responseCookies, { interactive: query.prompt !== 'none' }); }
        catch (error) {
            // The redirect URI is already trusted, so a late refusal (admission, method) returns to the app as an
            // OAuth error instead of an HTML page, as prompt=none requires.
            if (!(error instanceof AppError) || error.status >= 500) throw error;
            await env.DB.prepare('DELETE FROM auth_requests WHERE id=?').bind(id).run();
            return authorizationResponse(env, query, { error: oauthErrors.has(error.code) ? error.code : 'access_denied' }, responseCookies);
        }
    }
    return signInPage(env, id, responseCookies, client);
}
