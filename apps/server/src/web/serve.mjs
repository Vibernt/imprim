import { adminSession, requirePlatform } from '../admin/auth.mjs';
import { adminParts } from '../admin/path.mjs';
import { getSession } from '../auth/session.mjs';
import { lookAttributeEntries } from '../branding/look.mjs';
import { themeCss } from '../branding/theme.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { htmlLang, localeOf } from '../i18n/index.mjs';
import { sha256 } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
import { redirect } from '../lib/http.mjs';
import { fireDataScript, fireLabelScript } from '../pages/fire-labels.mjs';
import { accountWorkspacesPath, canSeeAccountWorkspaces } from '../workspaces/account-read.mjs';

export const WEB_PATHS = new Set([
    '/account',
    '/account/apps',
    accountWorkspacesPath,
    accountWorkspacesPath + '/:id',
    '/account/security',
    '/account/sessions',
    '/account/agents',
    '/admin',
    '/admin/clients',
    '/admin/clients/new',
    '/admin/clients/:id',
    '/admin/services',
    '/admin/users',
    '/admin/users/:id',
    '/admin/users/:id/merge',
    '/admin/audit',
    '/admin/signups',
    '/admin/workspaces',
    '/admin/workspaces/:id',
    '/admin/workspaces/:id/close',
    '/admin/branding',
    '/admin/settings',
    '/admin/keys',
    '/admin/realms',
]);
const WEB_INDEX = '/ui/index.html';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function matches(pattern, path) {
    const wanted = pattern.split('/'), actual = path.split('/');
    return wanted.length === actual.length && wanted.every((part, i) => part.startsWith(':') ? actual[i] !== '' : part === actual[i]);
}

const knownPath = path => [...WEB_PATHS].some(pattern => matches(pattern, path));
const normalizedPath = path => path.replace(/\/+$/, '');
const adminDocuments = new Set(['/admin/branding/preview', '/admin/branding/email-preview']);
const accountDocuments = new Set(['/account/mfa', '/account/password', '/account/email/confirm']);

export function webRequest(request, path) {
    const html = request.headers.get('accept')?.split(',').some(item => {
        const [type, ...params] = item.trim().toLowerCase().split(';');
        return type.trim() === 'text/html' && !params.some(param => /^q\s*=\s*0(?:\.0*)?$/.test(param.trim()));
    });
    const routePath = normalizedPath(path);
    return request.method === 'GET' && html && !adminDocuments.has(routePath) && !accountDocuments.has(routePath) &&
        !/^\/admin\/api(?:\/|$)/.test(path) &&
        (knownPath(routePath) || /^\/(?:account|admin)\//.test(path));
}

function rewriteShell(response, { lang, attributes, opening, stylesheet }) {
    return new HTMLRewriter()
        .on('html', { element(html) {
            html.setAttribute('lang', lang);
            for (const [name, value] of attributes) html.setAttribute(name, String(value));
        } })
        // The page data and the brand's stylesheet go in front of boot.js, which the build puts last in <head>: a classic
        // script after every stylesheet keeps Chromium from painting before Fire's CSS and the theme load (Fire 0.12.3).
        .on('script[src="/fire/boot.js"]', { element(script) {
            script.before(opening + stylesheet, { html: true });
        } })
        .transform(response);
}

const asset = id => id ? `/assets/brand/${id}` : undefined;

export async function serveWeb(request, env, url) {
    const next = encodeURIComponent(url.pathname + url.search);
    // Only admins can sign in at /login directly. A signed-out person on /account gets the account area's own
    // message (sign in to an app first), as before; a signed-out admin path goes to /login.
    const viewer = await getSession(request, env);
    if (!viewer) {
        invariant(url.pathname.startsWith('/admin'), 'login_required', 'Sign in to an app first, then return to your account.', 401);
        return redirect(`/login?next=${next}`);
    }
    const admin = url.pathname.startsWith('/admin');
    const path = normalizedPath(url.pathname);
    let known = knownPath(path);
    if (known && (path === accountWorkspacesPath || path.startsWith(accountWorkspacesPath + '/'))) {
        let id = path === accountWorkspacesPath ? undefined : path.slice(accountWorkspacesPath.length + 1);
        if (id !== undefined) {
            try { id = decodeURIComponent(id); } catch { id = ''; }
        }
        known = await canSeeAccountWorkspaces(env, viewer.user_id, id);
    }
    if (admin) {
        let session;
        try { session = await adminSession(request, env); }
        catch (error) {
            if (error.code === 'mfa_enrolment_required') return redirect(`/account/mfa?next=${next}`);
            if (error.code === 'mfa_required') return redirect(`/mfa?next=${next}`);
            throw error;
        }
        if (known) adminParts(url.pathname, false);
        if (known && /^\/admin\/(keys|realms)(\/|$)/.test(url.pathname)) requirePlatform(session);
    }
    invariant(env.ASSETS?.fetch, 'assets_config', 'The account interface is unavailable.', 503);
    const index = await env.ASSETS.fetch(new Request(new URL(WEB_INDEX, url)));
    invariant(index.ok && index.headers.get('content-type')?.startsWith('text/html'), 'assets_config', 'The account interface is unavailable.', 503);

    const brand = brandingFor(env), version = await sha256(themeCss(brand));
    const rewritten = rewriteShell(index, {
        lang: admin ? 'en' : htmlLang(localeOf(env), brand.locale),
        attributes: lookAttributeEntries(brand.look),
        opening: fireLabelScript(admin ? { I18N: { locale: 'en' } } : env) + fireDataScript('brand', {
            name: brand.name || env.REALM.display_name, mark: asset(brand.mark), logo: asset(brand.logo_light),
            logoDark: asset(brand.logo_dark)
        }),
        stylesheet: `<link rel="stylesheet" href="/assets/theme.css?v=${version}">`
    });
    const response = new Response(rewritten.body, { status: known ? 200 : 404, headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP,
        vary: 'Accept'
    } });
    shellResponses.add(response);
    return response;
}
// The app shell is branded here (rewriteShell). Every other HTML page, including server pages under /account/ such as
// /account/password and /account/mfa, still goes through withBrand, which also removes administrator-only parts.
const shellResponses = new WeakSet();
export const isShellResponse = response => shellResponses.has(response);
