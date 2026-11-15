// Registry providers: any OpenID Connect issuer, Microsoft (Entra ID) and Sign in with Apple. Authorization code with
// PKCE S256, state and nonce, a browser-bound cookie, and an ID token verified against the provider's JWKS.
// GitHub and Google keep their dedicated modules.
import { randomToken, sha256, challengeOf, safeEqual, b64url, from64 } from '../lib/crypto.mjs';
import { tokenShape, uniqueParams, redirect, readBody } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { cookies, issueSession, getSession } from '../auth/session.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { providerIdentity } from '../auth/provider-identity.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { audit } from '../services/audit.mjs';
export const UPSTREAM_COOKIE = '__Host-vi_up';
const STATE_MS = 600000;
const unavailable = (id, message = 'Sign-in provider request failed.') => invariant(false, 'provider_unavailable', `${id}: ${message}`, 502);
function providerConfig(env, id) {
    const provider = env.PROVIDERS?.[id];
    invariant(provider, 'provider_config', 'That sign-in provider is not configured for this realm.', 503);
    invariant(provider.client_id && (provider.type === 'apple' ? provider.private_key && provider.team_id && provider.key_id : provider.client_secret),
        'provider_config', 'That sign-in provider is missing credentials.', 503);
    return provider;
}
async function boundedJson(id, url, init = {}) {
    let response;
    try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) }); } catch { unavailable(id); }
    if (!response.ok || !response.body) { if (response.body) await response.body.cancel(); unavailable(id, `HTTP ${response.status}.`); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 262144) { await reader.cancel(); unavailable(id, 'Response too large.'); } chunks.push(value); }
    try { return { data: JSON.parse(await new Blob(chunks).text()), headers: response.headers }; } catch { unavailable(id, 'Invalid JSON.'); }
}
const APPLE = { issuer: 'https://appleid.apple.com', authorization_endpoint: 'https://appleid.apple.com/auth/authorize', token_endpoint: 'https://appleid.apple.com/auth/token', jwks_uri: 'https://appleid.apple.com/auth/keys' };
// Discovery and keys are public data, cached per isolate (and per database binding, so tests stay separate).
const discoveryCache = new WeakMap(), keyCache = new WeakMap();
const cacheFor = (map, env) => { const key = env.DB.raw ?? env.DB; if (!map.has(key)) map.set(key, new Map()); return map.get(key); };
const httpsUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };
async function metadata(env, id, provider) {
    if (provider.type === 'apple') return APPLE;
    const base = provider.type === 'microsoft' ? `https://login.microsoftonline.com/${provider.tenant || 'common'}/v2.0` : provider.issuer.replace(/\/$/, '');
    const cache = cacheFor(discoveryCache, env), hit = cache.get(base);
    if (hit && hit.until > Date.now()) return hit.value;
    const { data } = await boundedJson(id, `${base}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    const value = { issuer: data?.issuer, authorization_endpoint: httpsUrl(data?.authorization_endpoint), token_endpoint: httpsUrl(data?.token_endpoint), jwks_uri: httpsUrl(data?.jwks_uri) };
    if (typeof value.issuer !== 'string' || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) unavailable(id, 'Invalid discovery document.');
    // The document must describe the configured issuer (Microsoft's multi-tenant one carries a {tenantid} template).
    if (provider.type === 'oidc' && value.issuer.replace(/\/$/, '') !== base) unavailable(id, 'Discovery issuer does not match the configured issuer.');
    if (provider.type === 'microsoft' && !value.issuer.startsWith('https://login.microsoftonline.com/')) unavailable(id, 'Unexpected Microsoft issuer.');
    cache.set(base, { value, until: Date.now() + 3600000 });
    return value;
}
async function signingKey(env, id, jwksUri, kid, alg) {
    const cache = cacheFor(keyCache, env);
    for (let attempt = 0; attempt < 2; attempt++) {
        let hit = cache.get(jwksUri);
        if (!hit || hit.until <= Date.now() || (attempt === 1)) {
            const { data } = await boundedJson(id, jwksUri, { headers: { accept: 'application/json' } });
            invariant(Array.isArray(data?.keys) && data.keys.length <= 64, 'provider_unavailable', `${id}: Invalid key set.`, 502);
            hit = { keys: data.keys, until: Date.now() + 3600000 }; cache.set(jwksUri, hit);
        }
        const jwk = hit.keys.find(key => key.kid === kid && !key.d && (alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC' && key.crv === 'P-256'));
        if (jwk) {
            const { kty, n, e, crv, x, y } = jwk;
            return crypto.subtle.importKey('jwk', kty === 'RSA' ? { kty, n, e } : { kty, crv, x, y }, alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        }
    }
    invariant(false, 'invalid_grant', 'Unknown provider signing key.', 401);
}
const decodePart = part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(from64(part)));
async function verifyIdToken(env, id, provider, meta, token, nonce) {
    const bad = message => invariant(false, 'invalid_grant', `${id}: ${message}`, 401);
    if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) bad('Invalid ID token.');
    const [h, c, s] = token.split('.');
    let header, claims;
    try { header = decodePart(h); claims = decodePart(c); } catch { bad('Invalid ID token.'); }
    if (!['RS256', 'ES256'].includes(header?.alg) || typeof header.kid !== 'string' || header.jku || header.jwk || header.x5u || header.crit) bad('Unsupported ID token header.');
    const key = await signingKey(env, id, meta.jwks_uri, header.kid, header.alg);
    let signature = from64(s), valid = false;
    try { valid = await crypto.subtle.verify(header.alg === 'RS256' ? 'RSASSA-PKCS1-v1_5' : { name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(`${h}.${c}`)); } catch { bad('Invalid ID token signature.'); }
    if (!valid) bad('Invalid ID token signature.');
    const now = Math.floor(Date.now() / 1000);
    const issuer = provider.type === 'microsoft' ? meta.issuer.replace('{tenantid}', typeof claims.tid === 'string' ? claims.tid : '') : meta.issuer;
    if (claims?.iss !== issuer) bad('ID token issuer mismatch.');
    if (provider.type === 'microsoft' && /^[0-9a-f-]{36}$/.test(provider.tenant || '') && claims.tid !== provider.tenant) bad('ID token tenant mismatch.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(provider.client_id) || (aud.length > 1 && claims.azp !== provider.client_id)) bad('ID token audience mismatch.');
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= now || (claims.iat !== undefined && claims.iat > now + 300)) bad('ID token expired or not yet valid.');
    if (typeof claims.nonce !== 'string' || !await safeEqual(claims.nonce, nonce)) bad('ID token nonce mismatch.');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) bad('ID token has no subject.');
    return claims;
}
// Apple's client secret is a short-lived ES256 JWT signed with the team's key (PKCS#8 PEM in a Worker secret).
async function appleClientSecret(provider) {
    const pem = String(provider.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    let key;
    try { key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), ch => ch.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
    catch { invariant(false, 'provider_config', 'apple: private_key is not a PKCS#8 P-256 key.', 503); }
    const now = Math.floor(Date.now() / 1000), encode = value => b64url(new TextEncoder().encode(JSON.stringify(value)));
    const input = `${encode({ alg: 'ES256', kid: provider.key_id })}.${encode({ iss: provider.team_id, sub: provider.client_id, aud: 'https://appleid.apple.com', iat: now, exp: now + 300 })}`;
    return `${input}.${b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)))}`;
}
// Apple posts the callback cross-site (form_post), so its browser cookie needs SameSite=None; others stay Lax.
const stateCookie = (provider, value, maxAge) => `${UPSTREAM_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=${provider.type === 'apple' ? 'None' : 'Lax'}; Max-Age=${maxAge}`;
const callbackUrl = (env, id) => `${env.ISSUER}/login/provider/${id}/callback`;
export async function providerStart(request, env, id) {
    const query = uniqueParams(new URL(request.url).searchParams);
    const { row, client } = await pendingRequest(env, request, query.request_id);
    requireMethod(client, id);
    const provider = providerConfig(env, id), meta = await metadata(env, id, provider);
    const state = randomToken(), browser = randomToken(), verifier = randomToken(), nonce = randomToken();
    await env.DB.prepare('INSERT INTO oauth_states(hash,browser_hash,verifier,request_id,expires_at,provider,oidc_nonce) VALUES(?,?,?,?,?,?,?)')
        .bind(await sha256(state), await sha256(browser), verifier, row.id, Date.now() + STATE_MS, id, nonce).run();
    const params = new URLSearchParams({ client_id: provider.client_id, redirect_uri: callbackUrl(env, id), response_type: 'code', state, nonce,
        scope: provider.type === 'apple' ? 'openid email' : (provider.scopes || 'openid email profile'), code_challenge: await challengeOf(verifier), code_challenge_method: 'S256' });
    if (provider.type === 'apple') params.set('response_mode', 'form_post');
    const target = new URL(meta.authorization_endpoint);
    for (const [key, value] of params) target.searchParams.set(key, value);
    return redirect(target.href, [stateCookie(provider, browser, STATE_MS / 1000)]);
}
export async function providerCallback(request, env, id) {
    // Apple's form_post is a cross-site POST, which carries no SameSite=Lax cookies (the browser binding). Answer it
    // with a 303 to the same callback as a GET: a top-level GET navigation does carry them. State is not touched here.
    if (request.method === 'POST') {
        const posted = await readBody(request, 'form'), forward = new URLSearchParams();
        for (const key of ['code', 'state', 'error']) if (typeof posted[key] === 'string') forward.set(key, posted[key]);
        return redirect(`${callbackUrl(env, id)}?${forward}`);
    }
    const values = uniqueParams(new URL(request.url).searchParams);
    const browser = cookies(request)[UPSTREAM_COOKIE];
    invariant(tokenShape(values.state), 'invalid_grant', 'Invalid sign-in state.', 401);
    const row = await env.DB.prepare('DELETE FROM oauth_states WHERE hash=? AND provider=? RETURNING *').bind(await sha256(values.state), id).first();
    invariant(row && tokenShape(browser) && row.expires_at > Date.now() && await safeEqual(await sha256(browser), row.browser_hash),
        'invalid_grant', 'Sign-in state expired, used, or from another browser.', 401);
    invariant(!values.error && typeof values.code === 'string' && /^[\x21-\x7e]{1,4096}$/.test(values.code), 'invalid_grant', 'Sign-in cancelled or invalid.', 401);
    const { client } = await pendingRequest(env, request, row.request_id);
    requireMethod(client, id);
    const provider = providerConfig(env, id), meta = await metadata(env, id, provider);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: values.code, redirect_uri: callbackUrl(env, id), code_verifier: row.verifier, client_id: provider.client_id });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (provider.type === 'apple') form.set('client_secret', await appleClientSecret(provider));
    else if (provider.type === 'microsoft' || provider.token_auth === 'client_secret_post') form.set('client_secret', provider.client_secret);
    else headers.authorization = 'Basic ' + btoa(`${encodeURIComponent(provider.client_id)}:${encodeURIComponent(provider.client_secret)}`);
    const { data } = await boundedJson(id, meta.token_endpoint, { method: 'POST', headers, body: form.toString() });
    invariant(data && !data.error && typeof data.id_token === 'string', 'provider_unavailable', `${id}: Token exchange refused.`, 502);
    const claims = await verifyIdToken(env, id, provider, meta, data.id_token, row.oidc_nonce);
    invariant(typeof claims.email === 'string', 'access_denied', 'The provider did not share an email address.', 403);
    const email = normalizeEmail(claims.email);
    // Microsoft sends no email_verified; xms_edov says the tenant verified the email's domain.
    const verified = claims.email_verified === true || claims.email_verified === 'true' || (provider.type === 'microsoft' && [true, 'true', '1', 1].includes(claims.xms_edov));
    invariant(verified || provider.type === 'microsoft', 'access_denied', 'A verified email is required.', 403);
    // Mailbox proof only where the realm says this provider is authoritative for the email's domain: for Microsoft,
    // a pinned tenant that owns the domain. Otherwise the email is a provider claim (security pass S4); an
    // unvouched Microsoft email is weaker still and never satisfies an invitation (nOAuth).
    const domain = email.split('@')[1], pinned = /^[0-9a-f-]{36}$/.test(provider.tenant || '');
    const authoritative = (provider.trusted_domains || []).includes(domain) && (provider.type === 'microsoft' ? pinned : verified);
    const current = await pendingRequest(env, request, row.request_id);
    requireMethod(current.client, id);
    const user = await providerIdentity(env, current.client, id, { providerId: claims.sub, email, login: null, authoritative, verified: verified || authoritative }, await getSession(request, env));
    const signed = await issueSession(env, user, id);
    await audit(env, 'sign_in', user.id, { method: id });
    return completeAuthorization(env, request, row.request_id, signed.session, [...signed.cookies, stateCookie(provider, '', 0)]);
}
