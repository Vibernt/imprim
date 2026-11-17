import { authorizeAgent } from '../agents/authorize.mjs';
import { getClient, registeredUri } from './clients.mjs';
import { invariant, AppError } from '../lib/errors.mjs';
const oauthErrors = new Set(['invalid_request', 'access_denied', 'login_required', 'interaction_required', 'consent_required']);
import { uniqueParams, readBody, tokenShape } from '../lib/http.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { getSession, cookie, cookies, BROWSER_COOKIE } from '../auth/session.mjs';
import { authorizationResponse, completeAuthorization, withinMaxAge } from './requests.mjs';
import { allowsMethod } from './sign-in-methods.mjs';
import { ownIdToken } from './logout-hint.mjs';
import { signInPage } from '../pages/sign-in.mjs';
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
export async function authorize(request, env) {
    // OIDC Core 3.1.2.1: the same parameters may arrive as a form POST. Like the GET, it only starts a sign-in, so it
    // needs no Origin check: nothing happens until the person signs in on Imprim's own pages.
    const post = request.method === 'POST';
    const query = post ? await readBody(request, 'form') : uniqueParams(new URL(request.url).searchParams);
    if (query.resource !== undefined || query.client_id?.startsWith('https://') || query.client_id?.startsWith('agent_')) {
        invariant(!post, 'invalid_request', 'Agents start authorization with GET.');
        return authorizeAgent(request, env, query);
    }
    const client = await getClient(env, query.client_id);
    registeredUri(client, query.redirect_uri); // Never redirect errors until this boundary is trusted.
    // Classic OpenID Connect (off by default, confidential apps only) accepts requests from libraries written before
    // OAuth 2.1: no PKCE, no nonce, and a claims request that is ignored. A request that starts PKCE must finish it.
    const classic = client.classic_oidc === 'on' && Boolean(client.secret_hash);
    let hint = null;
    try {
        // First: a request object may carry the parameters checked below, so refusing it must not depend on them.
        invariant(query.request === undefined, 'request_not_supported', 'Request objects are not supported.');
        invariant(query.request_uri === undefined, 'request_uri_not_supported', 'request_uri is not supported.');
        invariant(query.response_type === 'code', 'unsupported_response_type', 'Only code is supported.');
        const pkce = query.code_challenge !== undefined || query.code_challenge_method !== undefined;
        invariant((classic && !pkce) || (query.code_challenge_method === 'S256' && tokenShape(query.code_challenge)), 'invalid_request', 'PKCE S256 required.');
        invariant(bounded(query.state), 'invalid_request', 'state required.');
        invariant((classic && query.nonce === undefined) || bounded(query.nonce), 'invalid_request', 'nonce required.');
        const scopes = (query.scope || '').split(' ');
        invariant(scopes.includes('openid') && scopes.every(s => ['openid', 'email', 'profile'].includes(s)), 'invalid_scope', 'Use openid, email and/or profile scopes.');
        invariant(query.prompt === undefined || ['none', 'login'].includes(query.prompt), 'invalid_request', 'Unsupported prompt.');
        invariant(!query.response_mode || query.response_mode === 'query', 'invalid_request', 'Only query response mode supported.');
        invariant(query.max_age === undefined || /^\d{1,9}$/.test(query.max_age), 'invalid_request', 'max_age must be whole seconds.');
        invariant(query.acr_values === undefined || (query.acr_values.length <= 512 && /^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(query.acr_values)), 'invalid_request', 'Invalid acr_values.');
        // OIDC Core 5.5 lets a provider that does not support claims requests ignore them; only classic apps send them.
        invariant(classic || query.claims === undefined, 'invalid_request', 'claims is not supported.');
        if (query.id_token_hint !== undefined) {
            // An ID token this issuer gave this app, possibly expired (OIDC Core 3.1.2.1). It names who the app expects.
            hint = await ownIdToken(env, query.id_token_hint);
            invariant(hint.aud === client.id, 'invalid_request', 'The ID token hint was issued to another app.');
        }
    } catch (error) {
        if (!error.code) throw error;
        return authorizationResponse(env, { ...query, state: query.state || '' }, { error: error.code });
    }
    let session = query.prompt === 'login' ? null : await getSession(request, env);
    // max_age: an older primary sign-in counts as no sign-in (OIDC Core 3.1.2.1).
    if (session && query.max_age !== undefined && !withinMaxAge(session.auth_time, Number(query.max_age))) session = null;
    if (session && !allowsMethod(client, session.method, session.google_hd, true)) session = null;
    // Someone other than the hinted person counts as no sign-in: prompt=none says login_required, otherwise sign in.
    if (session && hint && session.user_id !== hint.sub) session = null;
    if (!session && query.prompt === 'none') return authorizationResponse(env, query, { error: 'login_required' });
    const existing = cookies(request)[BROWSER_COOKIE];
    const browser = tokenShape(existing) ? existing : randomToken(), id = randomToken();
    const responseCookies = [cookie(BROWSER_COOKIE, browser, 1800)];
    // An empty challenge or nonce records that a classic app did not send one.
    await env.DB.prepare(`INSERT INTO auth_requests(id,client_id,redirect_uri,state,nonce,challenge,scope,browser_hash,expires_at,acr_values,max_age,prompt,hint_sub)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, client.id, query.redirect_uri, query.state, query.nonce ?? '',
            query.code_challenge ?? '', query.scope, await sha256(browser), Date.now() + 1800000, query.acr_values ?? null,
            query.max_age === undefined ? null : Number(query.max_age), query.prompt ?? null, hint?.sub ?? null).run();
    if (session) {
        // Carry the just-created binding internally for immediate SSO; never trust a caller-supplied request id.
        // Built from the URL: a POSTed authorization request's body has already been read.
        const headers = new Headers(request.headers);
        headers.set('cookie', `${BROWSER_COOKIE}=${browser}`);
        try { return await completeAuthorization(env, new Request(request.url, { headers }), id, session, responseCookies, { interactive: query.prompt !== 'none' }); }
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
