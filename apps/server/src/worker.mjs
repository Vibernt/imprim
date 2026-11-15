import { admin } from './admin/routes.mjs';
import { registerAgent } from './agents/registration.mjs';
import { consent } from './agents/consent.mjs';
import { deviceAuthorization, devicePage } from './agents/device.mjs';
import { account } from './agents/account.mjs';
import { AppError } from './lib/errors.mjs';
import { json } from './lib/http.mjs';
import { realmFor, realmEnv } from './realms/realm.mjs';
import { describeDevice } from './lib/device.mjs';
import { limitAddress } from './auth/rate-limit.mjs';
import { requestMagic, verifyMagic } from './auth/magic.mjs';
import { passwordSignIn } from './auth/password.mjs';
import { passwordPage } from './account/password.mjs';
import { mfaChallenge } from './auth/mfa-challenge.mjs';
import { mfaAccount } from './account/mfa.mjs';
import { accountAction } from './account/home.mjs';
import { registrationOptions, register, assertionOptions, assertionVerify, removePasskey } from './webauthn/ceremonies.mjs';
import { passkeyScript } from './webauthn/script.mjs';
import { providerStart, providerCallback, UPSTREAM_COOKIE } from './providers/upstream.mjs';
import { introspect, revoke, appGrants } from './machines/endpoints.mjs';
import { githubStart, githubCallback, OAUTH_COOKIE } from './auth/github-sign-in.mjs';
import { googleStart, googleCallback, GOOGLE_COOKIE } from './auth/google-sign-in.mjs';
import { cookie, getSession } from './auth/session.mjs';
import { authorize } from './oidc/authorize.mjs';
import { token, userinfo } from './oidc/token.mjs';
import { discovery } from './oidc/discovery.mjs';
import { cachedJwks } from './oidc/keys.mjs';
import { logout } from './oidc/logout.mjs';
import { invite } from './services/invitations.mjs';
import { scheduled, queue } from './services/maintenance.mjs';
import { loginPage, signInScript } from './pages/sign-in.mjs';
import { page, localCss, errorPage, signedOutPage, withBrand } from './pages/layout.mjs';
import { heading, linkButton } from './pages/ui.mjs';
import { themeResponse } from './branding/theme.mjs';
import { serveAsset } from './branding/assets.mjs';
const PROVIDER_START = /^\/v1\/auth\/provider\/([a-z][a-z0-9-]{1,39})\/start$/, PROVIDER_CALLBACK = /^\/login\/provider\/([a-z][a-z0-9-]{1,39})\/callback$/;
async function route(request, env, ctx, url) {
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin(request, env, ctx);
    const brandAsset = request.method === 'GET' && /^\/assets\/brand\/([0-9a-f]{64})$/.exec(url.pathname);
    if (brandAsset) return serveAsset(env, brandAsset[1]);
    const start = request.method === 'GET' && PROVIDER_START.exec(url.pathname);
    if (start) return providerStart(request, env, start[1]);
    const callback = ['GET', 'POST'].includes(request.method) && PROVIDER_CALLBACK.exec(url.pathname);
    if (callback) return providerCallback(request, env, callback[1]);
    const key = `${request.method} ${url.pathname}`;
    switch (key) {
        case 'GET /assets/local.css': return new Response(localCss, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
        case 'GET /assets/passkey.js': return new Response(passkeyScript, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
        case 'POST /v1/auth/passkey/options': return assertionOptions(request, env);
        case 'POST /v1/auth/passkey/verify': return assertionVerify(request, env, ctx);
        case 'POST /account/passkeys/options': return registrationOptions(request, env);
        case 'POST /account/passkeys/register': return register(request, env, ctx);
        case 'POST /account/passkeys/remove': return removePasskey(request, env, ctx);
        case 'GET /assets/sign-in.js': return new Response(signInScript, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
        case 'GET /.well-known/oauth-authorization-server':
        case 'GET /.well-known/openid-configuration': return json(discovery(env), 200, { 'access-control-allow-origin': '*' });
        case 'GET /.well-known/jwks.json': return json(await cachedJwks(env), 200, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
        case 'POST /register': return registerAgent(request, env);
        case 'POST /device_authorization': return deviceAuthorization(request, env);
        case 'GET /device': return devicePage(request, env);
        case 'GET /agent/consent': case 'POST /agent/consent': return consent(request, env);
        case 'GET /account': case 'POST /account/revoke': return account(request, env, ctx);
        case 'GET /authorize': return authorize(request, env);
        case 'POST /token': return token(request, env, ctx);
        case 'GET /userinfo': case 'POST /userinfo': return userinfo(request, env);
        case 'GET /logout': case 'POST /logout': return logout(request, env, ctx);
        case 'POST /v1/invitations': return invite(request, env);
        case 'POST /introspect': return introspect(request, env);
        case 'POST /revoke': return revoke(request, env, ctx);
        case 'GET /v1/grants': case 'POST /v1/grants/revoke': return appGrants(request, env, ctx);
        case 'POST /v1/auth/magic/request': return requestMagic(request, env, ctx);
        case 'POST /v1/auth/magic/verify': return verifyMagic(request, env);
        case 'POST /v1/auth/password': return passwordSignIn(request, env);
        case 'GET /account/password': case 'POST /account/password': return passwordPage(request, env, ctx);
        case 'GET /mfa': case 'POST /mfa': return mfaChallenge(request, env, ctx);
        case 'GET /account/mfa': case 'POST /account/mfa': return mfaAccount(request, env, ctx);
        case 'POST /account/profile': case 'POST /account/sessions': case 'POST /account/apps': case 'POST /account/devices':
        case 'POST /account/email': case 'GET /account/email/confirm': case 'POST /account/email/confirm': case 'POST /account/delete':
            return accountAction(request, env, ctx);
        case 'GET /v1/auth/github/start': return githubStart(request, env);
        case 'GET /auth/github/callback': return githubCallback(request, env);
        case 'GET /v1/auth/google/start': return googleStart(request, env);
        case 'GET /login/google/callback': return googleCallback(request, env);
        case 'GET /login': return loginPage(request, env);
        case 'GET /check-email': return page('Check your email', heading('Check your email', 'If this address can sign in here, a link arrives within a minute.') +
            '<p class="fd-small fd-muted">Open it in this browser. The link works once and expires in 15 minutes.</p>');
        case 'GET /signed-in': {
            if (!await getSession(request, env)) throw new AppError(401, 'login_required', 'Sign in first.');
            return page('Signed in', heading('You’re signed in', 'Go back to your app to continue.') + `<div class="fd-row" data-gap="3">${linkButton('Your account', '/account')}${linkButton('Admin console', '/admin', { variant: 'ghost' })}</div>`);
        }
        case 'GET /signed-out': return page('Signed out', heading('You’re signed out', env.REALM.branding?.copy?.signed_out || 'Apps you used keep their own sessions until you sign out there.'));
        case 'GET /assets/theme.css': return themeResponse(env, url);
        case 'GET /error': return errorPage('This sign-in request is missing or has expired.');
        default: throw new AppError(404, 'not_found', 'Endpoint not found.');
    }
}
// Public metadata is unlimited (and memoised); /token, /userinfo and /v1/invitations limit by the authenticated client
// inside the handler, because Worker-hosted apps share Cloudflare egress addresses (S2).
const unlimited = new Set(['GET /.well-known/openid-configuration', 'GET /.well-known/oauth-authorization-server', 'GET /.well-known/jwks.json',
    'GET /assets/local.css', 'GET /assets/sign-in.js', 'GET /assets/passkey.js', 'GET /assets/theme.css', 'POST /token', 'GET /userinfo', 'POST /userinfo', 'POST /v1/invitations',
    'POST /introspect', 'POST /revoke', 'GET /v1/grants', 'POST /v1/grants/revoke']);
export function limiterFor(method, path) {
    if (unlimited.has(`${method} ${path}`)) return null;
    return path.startsWith('/v1/auth/') || path.startsWith('/login/provider/') || ['/auth/github/callback', '/login/google/callback'].includes(path) ? 'AUTH_LIMITER' : 'API_LIMITER';
}
export async function handleRequest(request, base, ctx) {
    const url = new URL(request.url);
    let env = base;
    try {
        // The host selects the realm before anything else; every module below reads the realm-scoped env.
        // REQUEST and CTX let sign-in record the device and send notices without threading them through every call.
        env = { ...realmEnv(base, await realmFor(base, url.origin)), REQUEST: describeDevice(request), CTX: ctx };
        const limiter = limiterFor(request.method, url.pathname);
        if (limiter) await limitAddress(env, request, limiter);
        const response = await route(request, env, ctx, url);
        response.headers.set('x-content-type-options', 'nosniff');
        // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on HTML form POSTs, which the
        // strict Origin check (auth/session.mjs) refuses. Cross-origin navigations, such as redirects carrying OAuth
        // codes to apps, still send no referrer.
        response.headers.set('referrer-policy', 'same-origin');
        response.headers.set('strict-transport-security', 'max-age=31536000');
        return withBrand(response, env);
    } catch (error) {
        const known = error instanceof AppError;
        if (!known) console.error(JSON.stringify({ type: 'request_failed', path: url.pathname, code: 'internal_error' }));
        const code = known ? error.code : 'server_error', status = known ? error.status : 500;
        const message = known ? error.message : 'The request could not be completed.';
        const html = request.method === 'GET' && request.headers.get('accept')?.includes('text/html');
        // A person who opens their account page while signed out gets a page that says how to sign in, whatever
        // the request's Accept header; API clients of the same paths use POST and still get JSON.
        const signedOut = code === 'login_required' && request.method === 'GET' && /^\/(account(\/|$)|mfa$)/.test(url.pathname);
        const response = signedOut ? signedOutPage() : html ? errorPage(message, status) : json({ error: code, error_description: message }, status);
        if (code === 'invalid_client' && status === 401) response.headers.set('www-authenticate', `Basic realm="${(env.REALM?.display_name || 'identity').replace(/[^\x20-\x7e]|["\\]/g, '')}"`);
        if (code === 'invalid_token') response.headers.set('www-authenticate', 'Bearer error="invalid_token"');
        if (url.pathname === '/auth/github/callback') response.headers.append('set-cookie', cookie(OAUTH_COOKIE, '', 0));
        if (url.pathname === '/login/google/callback') response.headers.append('set-cookie', cookie(GOOGLE_COOKIE, '', 0));
        if (PROVIDER_CALLBACK.test(url.pathname)) response.headers.append('set-cookie', `${UPSTREAM_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`);
        return withBrand(response, env);
    }
}
export default { fetch: handleRequest, async scheduled(_event, env) { await scheduled(env); }, queue };
