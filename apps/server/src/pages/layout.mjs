// Every page is built from the Fire design system (public/fire, served as static files) and wears the brand of the
// request's realm, or of the app it names. There are two layouts: a centred screen (sign-in, consent, results) here,
// and the app shell for the console and the account pages (shell.mjs). Pages carry fixed markers that withBrand fills:
// the brand's name, logo and look, the footer, and who is signed in. Every user-supplied string is escaped, so `<` can
// never reach the output from input and no marker can be forged.
import { resolveBranding } from '../branding/tokens.mjs';
import { lookAttributes } from '../branding/look.mjs';
import { initialsOf } from '../auth/session.mjs';
import { adminRole } from '../services/admission.mjs';
import { escapeHtml, dotLogo, dotMark, icon, result } from './ui.mjs';
import { fireLabelScript } from './fire-labels.mjs';
import { nextSteps, stepsBlock } from './next-steps.mjs';
import { t, tHtml, localeOf, htmlLang, brandCopy } from '../i18n/index.mjs';
export { escapeHtml, icon };
const marker = name => `<!--identity:${name}-->`;
const appRoot = (lang, look = '') => `<html lang="${lang}" data-fd-surface="app"${look}>`;
// BRAND: the name. HEADER: the centred brand row. SIDE_BRAND and MARK: the shell's brand. FOOTER and SHELL_FOOTER: legal
// lines. VIEWER and INITIALS: the signed-in person's email and initials.
export const BRAND = marker('brand'), HEADER = marker('header'), HEAD = marker('head'), FOOTER = marker('footer'), SIDE_BRAND = marker('side-brand'),
    MARK = marker('mark'), SHELL_FOOTER = marker('shell-footer'), VIEWER = marker('viewer'), INITIALS = marker('initials');
// Markup only an administrator ("admin") or a platform administrator ("platform") gets; withBrand drops it for others.
export const only = (who, html) => `${marker(`if:${who}`)}${html}${marker(`end:${who}`)}`;
const POWERED_BY = marker('powered-by');
const poweredBy = `<p class="fd-screen-note"><span>${POWERED_BY}</span>${dotLogo('sm')}</p>`;
// Stopgaps for requests in docs/fire/REQUESTS.md use Imprim's im- prefix. No page links this empty stylesheet.
export const localCss = '/* Fire stopgaps for Imprim: none. See docs/fire/REQUESTS.md. */\n';
// Browsers keep /assets/local.css for an hour, so its link carries a hash of the rules: a release that changes them is
// picked up at once.
const localCssLink = localCss.includes('{')
    ? `<link rel="stylesheet" href="/assets/local.css?v=${[...localCss].reduce((hash, c) => Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36)}">` : '';
// The document around either layout. formTargets: origins a form on this page redirects to after it posts. Chrome applies
// form-action to those redirects, so the logout confirmation (to the app's post-logout URI) and the agent consent (to
// its callback) name them. client: the app whose branding this page wears; otherwise the realm's.
// script: classic scripts; modules: ES modules. /imprim/head.js stays the last element of <head>, after every
// stylesheet (the brand's theme.css comes in through HEAD), so Chromium never paints without Fire's CSS.
export function htmlResponse(title, inner, { script = '', modules = [], turnstile = false, cookies = [], status = 200, formTargets = [], client = null } = {}) {
    const formAction = ["'self'", ...new Set(formTargets.map(uri => new URL(uri).origin).filter(origin => origin !== 'null'))].join(' ');
    const headers = new Headers({
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        // Turnstile's origin is allowed only on pages that render the widget.
        'content-security-policy': `default-src 'self'; script-src 'self'${turnstile ? ' https://challenges.cloudflare.com' : ''}; frame-src ${turnstile ? 'https://challenges.cloudflare.com' : "'none'"}; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
        'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff'
    });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    const scripts = [script].flat().filter(Boolean).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join('') +
        modules.map(src => `<script type="module" src="${escapeHtml(src)}"></script>`).join('');
    return new Response(`<!doctype html>${appRoot('en')}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${client?.id && /^[A-Za-z0-9_-]{1,200}$/.test(client.id) ? marker(`client:${client.id}`) : ''}<title>${escapeHtml(title)} · ${BRAND}</title><link rel="stylesheet" href="/fire/fire.css">${localCssLink}${HEAD}<script src="/imprim/head.js"></script></head>
<body>${inner}${turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}${scripts}</body></html>`, { status, headers });
}
// The centred screen (Fire's fd-screen): the brand, one card, "Powered by", then the legal footer. `size` is sm or md.
export function page(title, body, { size = 'sm', ...options } = {}) {
    return htmlResponse(title, `<main class="fd-page"><div class="fd-frame" data-fill>
<section class="fd-band" data-pad="lg" data-grow data-align="center"><div class="fd-dotgrid" data-fade="radial" aria-hidden="true"></div>
<div class="fd-screen fd-rise"${size === 'md' ? ' data-size="md"' : ''}>${HEADER}
<div class="fd-corners"><article class="fd-card" data-size="lg">${body}</article></div>
${poweredBy}</div></section>
${FOOTER}</div></main>`, options);
}
// A signed-out visit to the account or second-factor pages. Only administrators can start a sign-in here (/login);
// everyone else signs in through an app, which leaves a session this page can use. The realm's apps with a sign-in
// page are offered (pages/next-steps.mjs).
export async function signedOutPage(env) {
    const apps = stepsBlock(await nextSteps(env).catch(() => []));
    return page(t(env, 'Sign in'), `<header class="fd-screen-head"><span class="fd-tile" data-size="44" data-tone="neutral">${icon('lock')}</span>
<h1 class="fd-h1">${escapeHtml(t(env, 'Sign in to see your account'))}</h1>
<p class="fd-muted">${tHtml(env, 'Your {brand} account opens from the apps that use it. Sign in to one of them in this browser, then come back here.').replace('{brand}', BRAND)}</p></header>
${apps}<p class="fd-screen-note"><span>${tHtml(env, 'Administrators can <0>sign in here</0>.', {}, [inner => `<a class="fd-link" href="/login">${inner}</a>`])}</span></p>`, { status: 401 });
}
// A sign-in that stopped. The page offers the next step: the sign-in again, the app, or a retry of its own (options.retry).
export async function errorPage(env, message, status = 400, options = {}) {
    // A failure to look up the next step (the database itself, say) leaves the page as it was, never a second error.
    const steps = stepsBlock(await nextSteps(env, options).catch(() => []));
    return page(t(env, 'Sign-in stopped'), result('circle-alert', 'danger', t(env, 'Sign-in stopped'), message) +
        (steps || `<p class="fd-screen-note">${escapeHtml(t(env, 'Go back to the app and start again.'))}</p>`), { status });
}
// Fills the markers for the request's realm and, if the page names one, its app: look, name, logo (with a dark variant)
// or the brand's initial in dots, favicon, brand stylesheet and footer; then the signed-in person, and the parts only
// administrators see. Everything inserted is escaped or an asset id.
export async function withBrand(response, env) {
    if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
    let html = await response.text();
    const clientId = /<!--identity:client:([A-Za-z0-9_-]{1,200})-->/.exec(html)?.[1];
    const client = clientId && env.REALM ? await env.DB.prepare('SELECT id,branding FROM clients WHERE id=? AND realm_id=?').bind(clientId, env.REALM.id).first() : null;
    const b = resolveBranding(env.REALM?.branding || {}, client ? JSON.parse(client.branding || '{}') : {});
    const footerCopy = brandCopy(env, b, 'footer');
    const plainName = b.name || env.REALM?.display_name || 'Identity', name = escapeHtml(plainName), asset = id => `/assets/brand/${id}`;
    const mark = b.mark ? `<img src="${asset(b.mark)}" alt="">` : dotMark(plainName);
    const markAndName = `<span class="fd-brand-mark">${mark}</span><span class="fd-brand-name">${name}</span>`;
    const header = `<div class="fd-brand">${b.logo_light
        ? `<picture>${b.logo_dark ? `<source srcset="${asset(b.logo_dark)}" media="(prefers-color-scheme: dark)">` : ''}<img class="fd-brand-logo" src="${asset(b.logo_light)}" alt="${name}"></picture>`
        : markAndName}</div>`;
    const links = [b.privacy_url && `<a class="fd-link" href="${escapeHtml(b.privacy_url)}">${escapeHtml(t(env, 'Privacy'))}</a>`, b.terms_url && `<a class="fd-link" href="${escapeHtml(b.terms_url)}">${escapeHtml(t(env, 'Terms'))}</a>`,
        b.support_url ? `<a class="fd-link" href="${escapeHtml(b.support_url)}">${escapeHtml(t(env, 'Help'))}</a>` : b.support_email && `<a class="fd-link" href="mailto:${escapeHtml(b.support_email)}">${escapeHtml(t(env, 'Help'))}</a>`].filter(Boolean);
    const notes = [b.legal_name && `<span>© ${escapeHtml(b.legal_name)}</span>`, footerCopy && `<span>${escapeHtml(footerCopy)}</span>`].filter(Boolean);
    const legal = [...notes, ...links].join('');
    const footer = legal ? `<footer class="fd-band" data-pad="sm"><div class="fd-row fd-small fd-muted" data-justify="center" data-wrap data-gap="4">${legal}</div></footer>` : '';
    const shellFooter = `<footer class="fd-band" data-pad="sm"><div class="fd-row fd-small fd-muted" data-justify="between" data-wrap data-gap="4"><div class="fd-row" data-wrap data-gap="4">${legal}</div>${poweredBy}</div></footer>`;
    const head = `<link rel="stylesheet" href="/assets/theme.css${client ? `?client=${encodeURIComponent(client.id)}` : ''}">${b.mark ? `<link rel="icon" href="${asset(b.mark)}">` : ''}`;
    const email = env.SEEN?.email || '', viewer = escapeHtml(email), initials = escapeHtml(initialsOf(email));
    // The role is looked up only for a page that has administrator-only parts.
    const role = html.includes('<!--identity:if:') && email ? env.SEEN.role ?? await adminRole(env, email) : null;
    const allowed = { admin: Boolean(role), platform: role === 'platform' };
    const open = appRoot(htmlLang(localeOf(env), b.locale), lookAttributes(b.look));
    // Replacements are functions, so `$&`, `$'` or `$\`` in a brand's text is inserted as text, never as a pattern.
    html = html.replace(/<!--identity:client:[A-Za-z0-9_-]{1,200}-->/, '').replace(appRoot('en'), () => open)
        .replace(/<!--identity:if:(admin|platform)-->([\s\S]*?)<!--identity:end:\1-->/g, (_, who, inner) => allowed[who] ? inner : '')
        .replaceAll(BRAND, () => name).replace(HEAD, () => head + fireLabelScript(env)).replace(HEADER, () => header).replace(FOOTER, () => footer)
        .replaceAll(SIDE_BRAND, () => markAndName).replaceAll(MARK, () => mark).replace(SHELL_FOOTER, () => shellFooter)
        .replaceAll(VIEWER, () => viewer).replaceAll(INITIALS, () => initials).replaceAll(POWERED_BY, () => escapeHtml(t(env, 'Powered by')));
    return new Response(html, { status: response.status, headers: response.headers });
}
