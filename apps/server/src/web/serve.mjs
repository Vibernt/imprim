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

export const WEB_PATHS = new Set([
    '/account',
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

export function webRequest(request, path) {
    const html = request.headers.get('accept')?.split(',').some(item => {
        const [type, ...params] = item.trim().toLowerCase().split(';');
        return type.trim() === 'text/html' && !params.some(param => /^q\s*=\s*0(?:\.0*)?$/.test(param.trim()));
    });
    const routePath = path.startsWith('/admin/') ? path.replace(/\/+$/, '') : path;
    return request.method === 'GET' && html && [...WEB_PATHS].some(pattern => matches(pattern, routePath));
}

function rewriteShell(response, { lang, attributes, opening, stylesheet }) {
    return new HTMLRewriter()
        .on('html', { element(html) {
            html.setAttribute('lang', lang);
            for (const [name, value] of attributes) html.setAttribute(name, String(value));
        } })
        .on('head', { element(head) {
            head.append(opening + stylesheet, { html: true });
        } })
        .transform(response);
}

const asset = id => id ? `/assets/brand/${id}` : undefined;

export async function serveWeb(request, env, url) {
    const next = encodeURIComponent(url.pathname + url.search);
    // Only admins can sign in at /login directly. A signed-out person on /account gets the account area's own
    // message (sign in to an app first), as before; a signed-out admin path goes to /login.
    if (!await getSession(request, env)) {
        invariant(url.pathname.startsWith('/admin'), 'login_required', 'Sign in to an app first, then return to your account.', 401);
        return redirect(`/login?next=${next}`);
    }
    const admin = url.pathname.startsWith('/admin');
    if (admin) {
        let session;
        try { session = await adminSession(request, env); }
        catch (error) {
            if (error.code === 'mfa_enrolment_required') return redirect(`/account/mfa?next=${next}`);
            if (error.code === 'mfa_required') return redirect(`/mfa?next=${next}`);
            throw error;
        }
        adminParts(url.pathname, false);
        if (/^\/admin\/(keys|realms)(\/|$)/.test(url.pathname)) requirePlatform(session);
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
    return new Response(rewritten.body, { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP,
        vary: 'Accept'
    } });
}
