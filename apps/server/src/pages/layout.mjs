// Every page is built from the Fire design system (public/fire, served as static files) and wears the brand of the
// request's realm, or of the app it names. Pages carry fixed markers that withBrand fills: the realm's name, the <html>
// look attributes, the brand stylesheet, the header and the footer. Every user-supplied string is escaped, so `<` can
// never reach the output from input and no marker can be forged.
import { resolveBranding } from '../branding/tokens.mjs';
import { lookAttributes } from '../branding/look.mjs';
import { escapeHtml, dotLogo, icon } from './ui.mjs';
export { escapeHtml };
export const BRAND = '<!--identity:brand-->', HEADER = '<!--identity:header-->', HEAD = '<!--identity:head-->', FOOTER = '<!--identity:footer-->';
// Stopgaps until Fire has them (docs/fire/GUIDE.md section 7; requests in docs/fire/REQUESTS.md). Fire tokens only.
export const localCss = `/* Fire stopgaps for Imprim. Classes use the x- prefix and Fire tokens only. See docs/fire/REQUESTS.md. */
/* Request 1: a wide wordmark beside fd-brand-name. */
.x-wordmark { block-size: var(--fd-icon-xl); inline-size: auto; color: var(--fd-accent); flex: none; }
/* Request 2: an uploaded logo image in fd-brand, light and dark. */
.x-logo { block-size: var(--fd-brand-mark); inline-size: auto; max-inline-size: var(--fd-size-sm); object-fit: contain; }
/* Request 3: a QR code that stays dark on light in both themes, so phones can scan it. */
.x-qr { inline-size: var(--fd-size-md); max-inline-size: 100%; padding: var(--fd-space-3); background: var(--fd-white, white); border-radius: var(--fd-radius-md); }
.x-qr svg { display: block; inline-size: 100%; block-size: auto; }
`;
// formTargets: origins a form on this page redirects to after it posts. Chrome applies form-action to those redirects, so
// the logout confirmation (to the app's post-logout URI) and the agent consent (to its callback) name them.
// client: the app whose branding this page wears (sign-in, consent, second factor); otherwise the realm's.
// wide: account and admin pages; nav: already-safe markup for the header's right side; modules: ES modules to load.
export function page(title, body, { script = '', modules = [], turnstile = false, cookies = [], status = 200, formTargets = [], client = null, wide = false, nav = '' } = {}) {
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
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${client?.id && /^[A-Za-z0-9_-]{1,200}$/.test(client.id) ? `<!--identity:client:${client.id}-->` : ''}<title>${escapeHtml(title)} · ${BRAND}</title><link rel="stylesheet" href="/fire/fire.css"><link rel="stylesheet" href="/assets/local.css">${HEAD}</head>
<body><main class="fd-page"><div class="fd-frame" data-fill>
<section class="fd-band" data-pad="sm"><div class="fd-row" data-justify="between" data-wrap data-gap="3">${HEADER}${nav}</div></section>
<section class="fd-band" data-pad="lg" data-grow><div class="fd-column" data-size="${wide ? 'xl' : 'sm'}" data-align="center"><div class="fd-stack" data-gap="6">${body}</div></div></section>
${FOOTER}</div></main>${turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}${scripts}</body></html>`, { status, headers });
}
// A signed-out visit to the account or second-factor pages. Only administrators can start a sign-in here (/login);
// everyone else signs in through an app, which leaves a session this page can use.
export const signedOutPage = () => page('Sign in', `<div class="fd-stack" data-gap="1-5"><h1 class="fd-h1">Sign in to see your account</h1>
<p class="fd-muted">Your ${BRAND} account opens from the apps that use it. Sign in to one of them in this browser, then come back here.</p></div>
<p class="fd-small fd-muted">Administrators can <a class="fd-link" href="/login">sign in here</a>.</p>`, { status: 401 });
export const errorPage = (message, status = 400) => page('Sign-in stopped', `<div class="fd-stack" data-gap="1-5"><h1 class="fd-h1">Sign-in stopped</h1>
<p class="fd-muted">${escapeHtml(message)}</p></div><p class="fd-small fd-muted">Go back to the app and start again.</p>`, { status });
// Fills the brand markers for the request's realm and, if the page names one, its app: look, name, logo (with a dark
// variant) or the IMPRIM dot logo, favicon, brand stylesheet and footer. Everything inserted is escaped or an asset id.
export async function withBrand(response, env) {
    if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
    let html = await response.text();
    const clientId = /<!--identity:client:([A-Za-z0-9_-]{1,200})-->/.exec(html)?.[1];
    const client = clientId && env.REALM ? await env.DB.prepare('SELECT id,branding FROM clients WHERE id=? AND realm_id=?').bind(clientId, env.REALM.id).first() : null;
    const b = resolveBranding(env.REALM?.branding || {}, client ? JSON.parse(client.branding || '{}') : {});
    const name = escapeHtml(b.name || env.REALM?.display_name || 'Identity'), asset = id => `/assets/brand/${id}`;
    const logo = b.logo_light ? `<picture>${b.logo_dark ? `<source srcset="${asset(b.logo_dark)}" media="(prefers-color-scheme: dark)">` : ''}<img class="x-logo" src="${asset(b.logo_light)}" alt="${name}"></picture>`
        : `${b.mark ? `<span class="fd-brand-mark"><img class="x-logo" src="${asset(b.mark)}" alt=""></span>` : dotLogo}<span class="fd-brand-name">${name}</span>`;
    const links = [b.privacy_url && `<a class="fd-link" href="${escapeHtml(b.privacy_url)}">Privacy</a>`, b.terms_url && `<a class="fd-link" href="${escapeHtml(b.terms_url)}">Terms</a>`,
        b.support_url ? `<a class="fd-link" href="${escapeHtml(b.support_url)}">Help</a>` : b.support_email && `<a class="fd-link" href="mailto:${escapeHtml(b.support_email)}">Help</a>`].filter(Boolean);
    const notes = [b.copy?.footer && `<span>${escapeHtml(b.copy.footer)}</span>`, b.legal_name && `<span>© ${escapeHtml(b.legal_name)}</span>`].filter(Boolean);
    const footer = links.length || notes.length ? `<footer class="fd-band" data-pad="sm"><div class="fd-row fd-small fd-muted" data-justify="between" data-wrap data-gap="3"><div class="fd-row" data-wrap data-gap="3">${notes.join('')}</div><nav class="fd-row" data-gap="4" aria-label="Legal">${links.join('')}</nav></div></footer>` : '';
    const head = `<link rel="stylesheet" href="/assets/theme.css${client ? `?client=${encodeURIComponent(client.id)}` : ''}">${b.mark ? `<link rel="icon" href="${asset(b.mark)}">` : ''}`;
    html = html.replace('<html lang="en">', `<html lang="${b.locale || 'en'}"${lookAttributes(b.look)}>`).replaceAll(BRAND, name).replace(HEAD, head)
        .replace(HEADER, `<div class="fd-brand fd-row" data-gap="3">${logo}</div>`).replace(FOOTER, footer);
    return new Response(html, { status: response.status, headers: response.headers });
}
export { icon };
