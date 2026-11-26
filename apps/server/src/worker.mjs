import { webRequest, serveWeb, isShellResponse } from './web/serve.mjs';
import { viewer } from './api/viewer.mjs';
import { catalogueResponse } from './api/catalogue.mjs';
import { profileApi } from './api/profile.mjs';
import { accountAccessApi } from './api/account-access.mjs';
import { accountSecurityApi } from './api/account-security.mjs';
import { admin } from './admin/routes.mjs';
import { registerAgent } from './agents/registration.mjs';
import { machineApproval } from './machines/approval.mjs';
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
import { passkeyScriptFor } from './webauthn/script.mjs';
import { providerStart, providerCallback, UPSTREAM_COOKIE } from './providers/upstream.mjs';
import { introspect, revoke, appGrants } from './machines/endpoints.mjs';
import { appUser } from './machines/users.mjs';
import { githubStart, githubCallback, OAUTH_COOKIE } from './auth/github-sign-in.mjs';
import { googleStart, googleCallback, GOOGLE_COOKIE } from './auth/google-sign-in.mjs';
import { cookie } from './auth/session.mjs';
import { authorize } from './oidc/authorize.mjs';
import { token, userinfo } from './oidc/token.mjs';
import { discovery } from './oidc/discovery.mjs';
import { cachedJwks } from './oidc/keys.mjs';
import { logout } from './oidc/logout.mjs';
import { invite } from './services/invitations.mjs';
import { scheduled, queue } from './services/maintenance.mjs';
import { loginPage, signInScriptFor } from './pages/sign-in.mjs';
import { checkEmailPage, pendingSignupPage } from './pages/signup.mjs';
import { localCss, errorPage, signedOutPage, withBrand } from './pages/layout.mjs';
import { signedIn, signedOut, signInError } from './pages/status.mjs';
import { pendingRequest } from './oidc/requests.mjs';
import { themeResponse } from './branding/theme.mjs';
import { startLocale, t, tError } from './i18n/index.mjs';
import { serveAsset } from './branding/assets.mjs';
import { workspaceApi, workspaceApiPath } from './workspaces/api.mjs';
import { workspaceJoin } from './workspaces/join.mjs';
import { workspaceAccess } from './workspaces/hosted-access.mjs';
import { switchAccount } from './auth/switch-account.mjs';
const PROVIDER_START = /^\/v1\/auth\/provider\/([a-z][a-z0-9-]{1,39})\/start$/, PROVIDER_CALLBACK = /^\/login\/provider\/([a-z][a-z0-9-]{1,39})\/callback$/;
async function route(request, env, ctx, url) {
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin(request, env, ctx);
    if (workspaceApiPath(request.method, url.pathname)) return workspaceApi(request, env, ctx, url);
    const brandAsset = request.method === 'GET' && /^\/assets\/brand\/([0-9a-f]{64})$/.exec(url.pathname);
    if (brandAsset) return serveAsset(env, brandAsset[1]);
    const start = request.method === 'GET' && PROVIDER_START.exec(url.pathname);
    if (start) return providerStart(request, env, start[1]);
    const callback = ['GET', 'POST'].includes(request.method) && PROVIDER_CALLBACK.exec(url.pathname);
    if (callback) return providerCallback(request, env, callback[1]);
    const catalogue = request.method === 'GET' && /^\/v1\/i18n\/([^/]+)\.json$/.exec(url.pathname);
    if (catalogue) return catalogueResponse(request, catalogue[1]);
    const key = `${request.method} ${url.pathname}`;
    switch (key) {
        case 'GET /assets/local.css': return new Response(localCss, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
        case 'GET /assets/passkey.js': return new Response(passkeyScriptFor(url.searchParams.get('lang')), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
        case 'POST /v1/auth/passkey/options': return assertionOptions(request, env);
        case 'POST /v1/auth/passkey/verify': return assertionVerify(request, env, ctx);
        case 'POST /account/passkeys/options': return registrationOptions(request, env);
        case 'POST /account/passkeys/register': return register(request, env, ctx);
        case 'POST /account/passkeys/remove': return removePasskey(request, env, ctx);
        case 'GET /assets/sign-in.js': return new Response(signInScriptFor(url.searchParams.get('lang')), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
        case 'GET /.well-known/oauth-authorization-server':
        case 'GET /.well-known/openid-configuration': return json(discovery(env), 200, { 'access-control-allow-origin': '*' });
        case 'GET /.well-known/jwks.json': return json(await cachedJwks(env), 200, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
        case 'POST /register': return registerAgent(request, env);
        case 'POST /device_authorization': return deviceAuthorization(request, env);
        case 'GET /device': return devicePage(request, env);
        case 'GET /machine-client': case 'POST /machine-client': return machineApproval(request, env);
        case 'GET /agent/consent': case 'POST /agent/consent': return consent(request, env);
        case 'POST /switch-account': return switchAccount(request, env, ctx);
        case 'GET /workspace-access': case 'POST /workspace-access': return workspaceAccess(request, env);
        case 'GET /workspace-join': case 'POST /workspace-join': return workspaceJoin(request, env);
        case 'POST /account/revoke': return account(request, env, ctx);
        case 'GET /v1/me': return viewer(request, env);
        case 'GET /v1/account/profile': case 'POST /v1/account/profile': return profileApi(request, env, ctx, 'profile');
        case 'POST /v1/account/language': return profileApi(request, env, ctx, 'language');
        case 'POST /v1/account/email': return profileApi(request, env, ctx, 'email');
        case 'POST /v1/account/delete': return profileApi(request, env, ctx, 'delete');
        case 'GET /v1/account/sessions': case 'POST /v1/account/sessions': return accountAccessApi(request, env, ctx, 'sessions');
        case 'GET /v1/account/apps': case 'POST /v1/account/apps': return accountAccessApi(request, env, ctx, 'apps');
        case 'POST /v1/account/devices': return accountAccessApi(request, env, ctx, 'devices');
        case 'GET /v1/account/agents': case 'POST /v1/account/agents/revoke': return accountAccessApi(request, env, ctx, 'agents');
        case 'POST /v1/account/machine-clients/disable': return accountAccessApi(request, env, ctx, 'machine-disable');
        case 'POST /v1/account/machine-clients/renew': return accountAccessApi(request, env, ctx, 'machine-renew');
        case 'POST /v1/account/agents/label': return accountAccessApi(request, env, ctx, 'agent-label');
        case 'GET /v1/account/security': return accountSecurityApi(request, env, ctx, 'overview');
        case 'POST /v1/account/mfa/start': return accountSecurityApi(request, env, ctx, 'start');
        case 'POST /v1/account/mfa/confirm': return accountSecurityApi(request, env, ctx, 'confirm');
        case 'POST /v1/account/mfa/remove': return accountSecurityApi(request, env, ctx, 'remove');
        case 'POST /v1/account/mfa/recovery': return accountSecurityApi(request, env, ctx, 'recovery');
        case 'POST /v1/account/passkeys/options': return accountSecurityApi(request, env, ctx, 'passkey-options');
        case 'POST /v1/account/passkeys/register': return accountSecurityApi(request, env, ctx, 'passkey-register');
        case 'POST /v1/account/passkeys/rename': return accountSecurityApi(request, env, ctx, 'passkey-rename');
        case 'POST /v1/account/passkeys/remove': return accountSecurityApi(request, env, ctx, 'passkey-remove');
        case 'POST /v1/account/password': return accountSecurityApi(request, env, ctx, 'password');
        case 'GET /authorize': case 'POST /authorize': return authorize(request, env);
        case 'POST /token': return token(request, env, ctx);
        case 'GET /userinfo': case 'POST /userinfo': return userinfo(request, env);
        case 'GET /logout': case 'POST /logout': return logout(request, env, ctx);
        case 'POST /v1/invitations': return invite(request, env);
        case 'POST /introspect': return introspect(request, env);
        case 'POST /revoke': return revoke(request, env, ctx);
        case 'GET /v1/grants': case 'POST /v1/grants/revoke': return appGrants(request, env, ctx);
        case 'GET /v1/users': return appUser(request, env, url);
        case 'POST /v1/auth/magic/request': return requestMagic(request, env, ctx);
        case 'POST /v1/auth/magic/verify': return verifyMagic(request, env, ctx);
        case 'POST /v1/auth/password': return passwordSignIn(request, env);
        case 'GET /account/password': case 'POST /account/password': return passwordPage(request, env, ctx);
        case 'GET /mfa': case 'POST /mfa': return mfaChallenge(request, env, ctx);
        case 'GET /account/mfa': case 'POST /account/mfa': return mfaAccount(request, env, ctx);
        case 'POST /account/profile': case 'POST /account/sessions': case 'POST /account/apps': case 'POST /account/devices':
        case 'POST /account/email': case 'POST /account/language': case 'GET /account/email/confirm': case 'POST /account/email/confirm': case 'POST /account/delete':
            return accountAction(request, env, ctx);
        case 'GET /v1/auth/github/start': return githubStart(request, env);
        case 'GET /auth/github/callback': return githubCallback(request, env);
        case 'GET /v1/auth/google/start': return googleStart(request, env);
        case 'GET /login/google/callback': return googleCallback(request, env);
        case 'GET /login': return loginPage(request, env, url);
        case 'GET /check-email': return checkEmailPage(request, env, url.searchParams.get('request_id'));
        case 'GET /signup-pending': return pendingSignupPage(request, env, url.searchParams.get('request_id'));
        case 'GET /signed-in': return signedIn(request, env);
        case 'GET /signed-out': return signedOut(env);
        case 'GET /assets/theme.css': return themeResponse(env, url);
        case 'GET /error': {
            await lookUpSignIn(env, request, url);
            return signInError(request, env, t(env, 'Go back to the app and start again.'), 400, { expired: !env.SIGN_IN?.id &&
                (!env.SIGN_IN?.app || env.SIGN_IN_EXPIRED) });
        }
        default:
            if (webRequest(request, url.pathname)) return serveWeb(request, env, url);
            throw new AppError(404, 'not_found', 'Endpoint not found.');
    }
}
// Public metadata is unlimited (and memoised); endpoints such as /token and /v1/users limit by the authenticated client
// inside the handler, because Worker-hosted apps share Cloudflare egress addresses (S2).
const unlimited = new Set(['GET /.well-known/openid-configuration', 'GET /.well-known/oauth-authorization-server', 'GET /.well-known/jwks.json',
    'GET /assets/local.css', 'GET /assets/sign-in.js', 'GET /assets/passkey.js', 'GET /assets/theme.css', 'POST /token', 'GET /userinfo', 'POST /userinfo', 'POST /v1/invitations',
    'POST /introspect', 'POST /revoke', 'GET /v1/grants', 'POST /v1/grants/revoke', 'GET /v1/users']);
export function limiterFor(method, path) {
    if (unlimited.has(`${method} ${path}`) || workspaceApiPath(method, path)) return null;
    return path.startsWith('/v1/auth/') || path.startsWith('/login/provider/') || ['/auth/github/callback', '/login/google/callback'].includes(path) ? 'AUTH_LIMITER' : 'API_LIMITER';
}
// Browser endpoints whose errors a person reads (sign-in.js, passkey.js and the account forms show them).
const PEOPLE_PATHS = /^\/(?:v1\/(?:auth|account)\/|account(?:\/|$)|mfa$|agent\/consent$|machine-client$|workspace-join$|workspace-access$|switch-account$|device$|logout$|login$|signed-in$)/;
// Browser form posts whose refusals are pages (with Accept: text/html); scripts on these paths use fetch, which does not ask for HTML.
const HTML_FORMS = new Set(['/authorize', '/workspace-join', '/workspace-access', '/switch-account', '/agent/consent', '/machine-client', '/mfa', '/account/password']);
// The request_id of a GET query or of a form posted to HTML_FORMS, looked up only to offer "Sign in again" on the page.
async function lookUpSignIn(env, request, url, form) {
    try {
        const id = request.method === 'GET' ? url.searchParams.get('request_id') : form ? (await form.formData()).get('request_id') : null;
        if (typeof id === 'string' && id) await pendingRequest(env, request, id);
    } catch (error) {
        if (!(error instanceof AppError) || error.status >= 500) throw error;
    }
}
export async function handleRequest(request, base, ctx) {
    const url = new URL(request.url);
    // A copy of a posted form, read only if its refusal becomes a page.
    const form = request.method === 'POST' && HTML_FORMS.has(url.pathname) && request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded') ? request.clone() : null;
    let env = base;
    try {
        // The host selects the realm before anything else; every module below reads the realm-scoped env.
        // REQUEST and CTX let sign-in record the device and send notices without threading them through every call;
        // SEEN is who the request's session belongs to, for the shell's account row (auth/session.mjs fills it).
        env = { ...realmEnv(base, await realmFor(base, url.origin)), REQUEST: describeDevice(request), CTX: ctx, SEEN: {} };
        // The page language, from the realm and Accept-Language; handlers add the app, ui_locales and the person.
        startLocale(env, request, url);
        const limiter = limiterFor(request.method, url.pathname);
        if (limiter) await limitAddress(env, request, limiter);
        const response = await route(request, env, ctx, url);
        response.headers.set('x-content-type-options', 'nosniff');
        // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on HTML form POSTs, which the
        // strict Origin check (auth/session.mjs) refuses. Cross-origin navigations, such as redirects carrying OAuth
        // codes to apps, still send no referrer.
        response.headers.set('referrer-policy', 'same-origin');
        response.headers.set('strict-transport-security', 'max-age=31536000');
        return isShellResponse(response) ? response : await withBrand(response, env);
    } catch (error) {
        const known = error instanceof AppError;
        if (!known) console.error(JSON.stringify({ type: 'request_failed', path: url.pathname, code: 'internal_error' }));
        const code = known ? error.code : 'server_error', status = known ? error.status : 500;
        // A person's browser may POST an authorization request (OIDC Core 3.1.2.1); refusals before the redirect is trusted are pages.
        const workspaceRequest = workspaceApiPath(request.method, url.pathname);
        const jsonRequest = workspaceRequest || (request.method === 'GET' && url.pathname === '/v1/users') ||
            /^\/(?:v1\/(?:me$|account\/|i18n\/)|admin\/api(?:\/|$))/.test(url.pathname);
        // Forms people submit on Imprim's pages answer a page too: a JSON body in the browser is a dead end.
        const html = !jsonRequest && (request.method === 'GET' || HTML_FORMS.has(url.pathname)) &&
            request.headers.get('accept')?.includes('text/html');
        // People read the message on an error page, or in the sign-in and account scripts, so it is translated there.
        // Protocol endpoints keep English: RFC 6749 limits error_description to ASCII, and developers read it.
        const message = known ? (html || PEOPLE_PATHS.test(url.pathname) ? tError(env, error) : error.message)
            : jsonRequest && !PEOPLE_PATHS.test(url.pathname) ? 'The request could not be completed.' : t(env, 'The request could not be completed.');
        // A person who opens their account page while signed out gets a page that says how to sign in, whatever
        // the request's Accept header; API clients of the same paths use POST and still get JSON.
        const signedOut = code === 'login_required' && request.method === 'GET' && /^\/(account(\/|$)|mfa$)/.test(url.pathname);
        const requestStep = ['/mfa', '/account/mfa', '/account/password'].includes(url.pathname);
        let response;
        try {
            const expired = request.method === 'GET' && ['browser_binding', 'invalid_request'].includes(code) && env.SIGN_IN_EXPIRED;
            // Link back into a sign-in request when the error handler stopped before looking it up.
            if ((signedOut ? requestStep : html) && env.REALM && status < 500 && !env.SIGN_IN) await lookUpSignIn(env, request, url, form);
            response = signedOut ? await signedOutPage(env, { forRequest: requestStep })
                : html && env.REALM && status < 500 ? await signInError(request, env, message, status, { retry: env.RETRY, expired })
                : html ? await errorPage(env, message, status)
                : json({ error: code, error_description: message }, status);
            if (html || signedOut) response = await withBrand(response, env);
        } catch {
            console.error(JSON.stringify({ type: 'error_page_failed', path: url.pathname, code: 'internal_error' }));
            const errorEnv = { ...env, SIGN_IN: null };
            return withBrand(await errorPage(errorEnv, t(errorEnv, 'The request could not be completed.'), 500), errorEnv);
        }
        if (code === 'invalid_client' && status === 401) response.headers.set('www-authenticate', `Basic realm="${(env.REALM?.display_name || 'identity').replace(/[^\x20-\x7e]|["\\]/g, '')}"`);
        if (code === 'invalid_token') response.headers.set('www-authenticate', 'Bearer error="invalid_token"');
        if (url.pathname === '/auth/github/callback') response.headers.append('set-cookie', cookie(OAUTH_COOKIE, '', 0));
        if (url.pathname === '/login/google/callback') response.headers.append('set-cookie', cookie(GOOGLE_COOKIE, '', 0));
        if (PROVIDER_CALLBACK.test(url.pathname)) response.headers.append('set-cookie', `${UPSTREAM_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`);
        return response;
    }
}
export default { fetch: handleRequest, async scheduled(_event, env) { await scheduled(env); }, queue };
