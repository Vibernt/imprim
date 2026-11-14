import { admin } from './admin/routes.mjs';
import { registerAgent } from './agents/registration.mjs';
import { consent } from './agents/consent.mjs';
import { deviceAuthorization, devicePage } from './agents/device.mjs';
import { account } from './agents/account.mjs';
import { AppError } from './lib/errors.mjs';
import { json } from './lib/http.mjs';
import { realmFor, realmEnv } from './realms/realm.mjs';
import { limitAddress } from './auth/rate-limit.mjs';
import { requestMagic, verifyMagic } from './auth/magic.mjs';
import { passwordSignIn } from './auth/password.mjs';
import { passwordPage } from './account/password.mjs';
import { mfaChallenge } from './auth/mfa-challenge.mjs';
import { mfaAccount } from './account/mfa.mjs';
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
import { page, pageCss, errorPage, withBrand } from './pages/layout.mjs';
async function route(request, env, ctx, url) {
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin(request, env, ctx);
    const key = `${request.method} ${url.pathname}`;
    switch (key) {
        case 'GET /assets/page.css': return new Response(pageCss, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
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
        case 'POST /v1/auth/magic/request': return requestMagic(request, env, ctx);
        case 'POST /v1/auth/magic/verify': return verifyMagic(request, env);
        case 'POST /v1/auth/password': return passwordSignIn(request, env);
        case 'GET /account/password': case 'POST /account/password': return passwordPage(request, env, ctx);
        case 'GET /mfa': case 'POST /mfa': return mfaChallenge(request, env, ctx);
        case 'GET /account/mfa': case 'POST /account/mfa': return mfaAccount(request, env, ctx);
        case 'GET /v1/auth/github/start': return githubStart(request, env);
        case 'GET /auth/github/callback': return githubCallback(request, env);
        case 'GET /v1/auth/google/start': return googleStart(request, env);
        case 'GET /login/google/callback': return googleCallback(request, env);
        case 'GET /login': return loginPage(request, env);
        case 'GET /check-email': return page('Check your email', '<h1>Check your email</h1><p>If this address is eligible, a link will arrive shortly. Open it in the browser where you started and choose Sign in.</p>');
        case 'GET /signed-in': {
            if (!await getSession(request, env)) throw new AppError(401, 'login_required', 'Sign in first.');
            return page('Signed in', '<h1>You are signed in</h1><p>Return to your app or <a href="/admin">open the admin console</a>.</p>');
        }
        case 'GET /signed-out': return page('Signed out', `<h1>You are signed out</h1><p>Apps may still have their own active sessions.</p>`);
        case 'GET /error': return errorPage('Return to the app and start again.');
        default: throw new AppError(404, 'not_found', 'Endpoint not found.');
    }
}
// Public metadata is unlimited (and memoised); /token, /userinfo and /v1/invitations limit by the authenticated client
// inside the handler, because Worker-hosted apps share Cloudflare egress addresses (S2).
const unlimited = new Set(['GET /.well-known/openid-configuration', 'GET /.well-known/oauth-authorization-server', 'GET /.well-known/jwks.json',
    'GET /assets/page.css', 'GET /assets/sign-in.js', 'POST /token', 'GET /userinfo', 'POST /userinfo', 'POST /v1/invitations']);
export function limiterFor(method, path) {
    if (unlimited.has(`${method} ${path}`)) return null;
    return path.startsWith('/v1/auth/') || ['/auth/github/callback', '/login/google/callback'].includes(path) ? 'AUTH_LIMITER' : 'API_LIMITER';
}
export async function handleRequest(request, base, ctx) {
    const url = new URL(request.url);
    let env = base;
    try {
        // The host selects the realm before anything else; every module below reads the realm-scoped env.
        env = realmEnv(base, await realmFor(base, url.origin));
        const limiter = limiterFor(request.method, url.pathname);
        if (limiter) await limitAddress(env, request, limiter);
        const response = await route(request, env, ctx, url);
        response.headers.set('x-content-type-options', 'nosniff');
        // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on HTML form POSTs, which the
        // strict Origin check (auth/session.mjs) refuses. Cross-origin navigations, such as redirects carrying OAuth
        // codes to apps, still send no referrer.
        response.headers.set('referrer-policy', 'same-origin');
        response.headers.set('strict-transport-security', 'max-age=31536000');
        return withBrand(response, env.REALM.display_name);
    } catch (error) {
        const known = error instanceof AppError;
        if (!known) console.error(JSON.stringify({ type: 'request_failed', path: url.pathname, code: 'internal_error' }));
        const code = known ? error.code : 'server_error', status = known ? error.status : 500;
        const message = known ? error.message : 'The request could not be completed.';
        const html = request.method === 'GET' && request.headers.get('accept')?.includes('text/html');
        const response = html ? errorPage(message, status) : json({ error: code, error_description: message }, status);
        if (code === 'invalid_client' && status === 401) response.headers.set('www-authenticate', `Basic realm="${(env.REALM?.display_name || 'identity').replace(/[^\x20-\x7e]|["\\]/g, '')}"`);
        if (code === 'invalid_token') response.headers.set('www-authenticate', 'Bearer error="invalid_token"');
        if (url.pathname === '/auth/github/callback') response.headers.append('set-cookie', cookie(OAUTH_COOKIE, '', 0));
        if (url.pathname === '/login/google/callback') response.headers.append('set-cookie', cookie(GOOGLE_COOKIE, '', 0));
        return withBrand(response, env.REALM?.display_name);
    }
}
export default { fetch: handleRequest, async scheduled(_event, env) { await scheduled(env); }, queue };
