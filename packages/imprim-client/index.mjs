import { resourceMetadata, challengeHeader } from './resources.mjs';
import { createVerifier } from './jwt.mjs';
import { backchannelMethods, validateResourcePrefixes } from './backchannel.mjs';
// Zero-dependency OIDC relying-party client for Workers and Node 20+.
// `message` is always this package's own text. Server-supplied `error_description` is kept apart in `description`:
// it is untrusted input, so escape it before showing it.
export class IdentityError extends Error {
    constructor(code, message, description) { super(message || code); this.name = 'IdentityError'; this.code = code; if (description !== undefined) this.description = description; }
}
const fail = (code, message, description) => { throw new IdentityError(code, message, description); };
const describe = value => typeof value === 'string' ? value.slice(0, 500) : undefined;
// JWKS: refetched after 10 minutes, so an emergency key revocation takes effect quickly; if identity is unreachable,
// keys up to 24 hours old keep verifying.
export const JWKS_FRESH_MS = 600000, JWKS_STALE_MS = 86400000;
const bytes = value => new TextEncoder().encode(value);
const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
function unique(params) {
    for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) fail('invalid_response', `Duplicate ${key}.`);
}
function endpoint(value, issuer) {
    let url;
    try { url = new URL(value); } catch { fail('discovery', 'Invalid endpoint URL.'); }
    if (url.origin !== issuer.origin || url.username || url.password || url.hash) fail('discovery', 'Endpoint is outside issuer origin.');
    return url.href;
}
async function responseJson(response, code) {
    let data;
    try { data = await response.json(); } catch { fail(code, 'Invalid JSON response.'); }
    if (!response.ok) fail(typeof data?.error === 'string' && /^[a-z_]{1,64}$/.test(data.error) ? data.error : code, `Identity ${code} request failed (HTTP ${response.status}).`, describe(data?.error_description));
    return data;
}
export function createClient({ issuer, clientId, clientSecret, redirectUri, resourcePrefixes, fetch: fetchOption } = {}) {
    let base;
    try { base = new URL(issuer); } catch { fail('configuration', 'Invalid issuer.'); }
    if (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password || (typeof clientId !== 'string' || !clientId) || (redirectUri !== undefined && (typeof redirectUri !== 'string' || !redirectUri)) || (clientSecret !== undefined && typeof clientSecret !== 'string')) fail('configuration', 'Invalid client configuration.');
    validateResourcePrefixes(resourcePrefixes, fail);
    resourcePrefixes = resourcePrefixes?.slice();
    const issuerText = base.href.replace(/\/$/, '');
    const transport = fetchOption || globalThis.fetch;
    if (typeof transport !== 'function') fail('configuration', 'fetch is required.');
    const request = async (url, init) => {
        try { return await transport(url, init); }
        catch (error) { fail('network', `Identity request failed: ${error?.message || 'network error'}`); }
    };
    let discoveryPromise, jwks, jwksAt = 0;
    async function discovery() {
        // A failed discovery is not cached: the next call tries again.
        if (!discoveryPromise) discoveryPromise = (async () => {
            const data = await responseJson(await request(`${issuerText}/.well-known/openid-configuration`), 'discovery');
            if (data.issuer !== issuerText || !data.id_token_signing_alg_values_supported?.includes('ES256') || !data.code_challenge_methods_supported?.includes('S256')) fail('discovery', 'Issuer metadata mismatch.');
            return { authorize: endpoint(data.authorization_endpoint, base), token: endpoint(data.token_endpoint, base), jwks: endpoint(data.jwks_uri, base), logout: endpoint(data.end_session_endpoint, base) };
        })();
        try { return await discoveryPromise; }
        catch (error) { discoveryPromise = undefined; throw error; }
    }
    async function keys(force = false) {
        const age = Date.now() - jwksAt;
        if (!force && jwks && age < JWKS_FRESH_MS) return jwks;
        try {
            const data = await responseJson(await request((await discovery()).jwks), 'jwks');
            if (!Array.isArray(data.keys)) fail('jwks', 'Invalid JWKS.');
            jwks = data.keys; jwksAt = Date.now();
        } catch (error) {
            // Outage: keep verifying with recent keys. A forced refresh (unknown kid) never falls back.
            if (force || !jwks || age >= JWKS_STALE_MS || !['network', 'jwks', 'discovery'].includes(error?.code)) throw error;
        }
        return jwks;
    }
    const verify = createVerifier({ keys, issuerText, clientId, resourcePrefixes, fail });
    return {
        ...backchannelMethods(verify, fail),
        async startLogin({ state, nonce, prompt, loginHint, method } = {}) {
            if (!redirectUri) fail('configuration', 'redirectUri is required for login.');
            const values = { state: state ?? random(), nonce: nonce ?? random(), codeVerifier: random() };
            if (!values.state || !values.nonce || values.state.length > 512 || values.nonce.length > 512) fail('configuration', 'Invalid state or nonce.');
            if (method !== undefined && !['email', 'github', 'google'].includes(method)) fail('configuration', 'Invalid sign-in method.');
            const challenge = b64(await crypto.subtle.digest('SHA-256', bytes(values.codeVerifier)));
            const url = new URL((await discovery()).authorize);
            const params = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email', state: values.state, nonce: values.nonce, code_challenge: challenge, code_challenge_method: 'S256' };
            if (prompt !== undefined) params.prompt = prompt;
            if (loginHint !== undefined) params.login_hint = loginHint;
            if (method !== undefined) params.method = method;
            for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
            return { url: url.href, ...values };
        },
        async handleCallback(url, { state, nonce, codeVerifier } = {}) {
            if (!redirectUri) fail('configuration', 'redirectUri is required for login.');
            let callback;
            try { callback = new URL(url); } catch { fail('invalid_response', 'Invalid callback URL.'); }
            if (callback.origin + callback.pathname !== new URL(redirectUri).origin + new URL(redirectUri).pathname) fail('invalid_response', 'Callback URL mismatch.');
            unique(callback.searchParams);
            if (!state || !callback.searchParams.get('state') || callback.searchParams.get('state') !== state) fail('invalid_state', 'State mismatch.');
            // RFC 9207: discovery advertises iss in responses, so a response without it is refused (mix-up defence).
            if (callback.searchParams.get('iss') !== issuerText) fail('invalid_issuer', 'Authorization response issuer missing or mismatched.');
            if (callback.searchParams.has('error')) {
                const error = callback.searchParams.get('error');
                fail(/^[a-z_]{1,64}$/.test(error || '') ? error : 'invalid_response', 'Authorization failed.', describe(callback.searchParams.get('error_description') ?? undefined));
            }
            const code = callback.searchParams.get('code');
            if (!code || !nonce || !codeVerifier) fail('invalid_response', 'Missing code or login transaction.');
            const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
            const headers = { 'content-type': 'application/x-www-form-urlencoded' };
            if (clientSecret !== undefined) {
                const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
                headers.authorization = `Basic ${btoa(encoded)}`;
            } else form.set('client_id', clientId);
            const data = await responseJson(await request((await discovery()).token, { method: 'POST', headers, body: form }), 'token');
            if (typeof data.id_token !== 'string') fail('invalid_response', 'Token response has no ID token.');
            return verify(data.id_token, { nonce });
        },
        verifyAccessToken: (jwt, { audience, clockSkewSeconds } = {}) => verify(jwt, { access: true, audience, clockSkewSeconds }),
        protectedResourceMetadata: options => resourceMetadata(issuerText, options, fail),
        wwwAuthenticate,
        verifyIdToken: (jwt, { nonce, maxAge } = {}) => verify(jwt, { nonce, maxAge }),
        async logoutUrl({ idTokenHint, postLogoutRedirectUri, state } = {}) {
            const url = new URL((await discovery()).logout);
            url.searchParams.set('client_id', clientId);
            if (idTokenHint !== undefined) url.searchParams.set('id_token_hint', idTokenHint);
            if (postLogoutRedirectUri !== undefined) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
            if (state !== undefined) url.searchParams.set('state', state);
            return url.href;
        },
        async inviteEmail(email) {
            if (clientSecret === undefined) fail('configuration', 'Invitations require a confidential client.');
            if (typeof email !== 'string' || !email.includes('@')) fail('configuration', 'Invalid email.');
            const authorization = `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
            return responseJson(await request(`${issuerText}/v1/invitations`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ email }) }), 'invitation');
        }
    };
}

export const wwwAuthenticate = options => challengeHeader(options, fail);

// Use a long-lived createClient instance when shared discovery/JWKS caching is needed.
export const verifyLogoutToken = (token, options) => createClient(options).verifyLogoutToken(token, options);
export const verifyRevocationToken = (token, options) => createClient(options).verifyRevocationToken(token, options);
export const verifyBackchannel = (form, options) => createClient(options).verifyBackchannel(form, options);
