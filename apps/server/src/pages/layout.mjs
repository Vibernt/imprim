import { resolveBranding } from '../branding/tokens.mjs';
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Pages carry a fixed marker where the realm's name goes; the worker fills it for the request's realm (withBrand).
// Every user-supplied string is escaped, so `<` can never reach the output from input and the marker cannot be forged.
export const BRAND = '<!--identity:brand-->', HEADER = '<!--identity:header-->', HEAD = '<!--identity:head-->', FOOTER = '<!--identity:footer-->';
// The base design reads only CSS variables, which /assets/theme.css sets from the realm's and app's tokens.
export const pageCss = `:root{--primary:#2346d8;--primary-text:#fff;--bg:#f4f5f7;--surface:#fff;--text:#14181d;--muted:#525c67;--border:#d5dae0;--danger:#b42318;--radius:10px;--font:system-ui,sans-serif}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:6vh 1rem 2rem;font:16px/1.55 var(--font);color:var(--text);background:var(--bg)}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:650;font-size:1.05rem;margin:0 0 1.25rem;max-width:30rem;width:100%}.brand img{height:2rem;width:auto;max-width:12rem}.brand .mark{width:2rem;height:2rem}
main{width:100%;max-width:30rem;background:var(--surface);border:1px solid var(--border);border-radius:calc(var(--radius) * 1.4);padding:clamp(1.25rem,4vw,2rem);box-shadow:0 1px 2px rgb(0 0 0/.04),0 8px 24px rgb(0 0 0/.06)}
main.wide{max-width:52rem}h1{font-size:1.5rem;line-height:1.25;margin:0 0 1rem}h2{font-size:1.1rem;margin:1.75rem 0 .5rem}h3{font-size:1rem;margin:1rem 0 .25rem}p{margin:.5rem 0}
a{color:var(--primary);text-underline-offset:.15em}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--primary);outline-offset:2px}
label{display:block;font-weight:600;font-size:.95rem;margin:1rem 0 .35rem}input,textarea,select{display:block;width:100%;font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:.65rem .75rem}
input[type=checkbox]{display:inline-block;width:auto;margin-right:.4rem}label:has(input[type=checkbox]){font-weight:500}
button{display:block;width:100%;margin:.75rem 0 0;font:inherit;font-weight:600;cursor:pointer;color:var(--primary-text);background:var(--primary);border:1px solid var(--primary);border-radius:var(--radius);padding:.7rem 1rem}
button+button,button[value=link],button[value=set],button[value=deny],li form button,#email-form~p #passkey-sign-in{color:var(--primary);background:transparent}button:disabled{opacity:.6;cursor:progress}
a[href^="/v1/auth/"]{display:block;text-align:center;text-decoration:none;font-weight:600;color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:.7rem 1rem;margin:.75rem 0 0}a[href^="/v1/auth/"]:hover{border-color:var(--muted)}
#request>p{margin:0}#email-form+p,#request>p:first-of-type{margin-top:1.25rem}li{margin:.4rem 0}li form{display:inline}li form button{display:inline-block;width:auto;margin:0 0 0 .5rem;padding:.25rem .6rem;font-size:.85rem}
section{border-top:1px solid var(--border);padding-top:.5rem;margin-top:.75rem}ul{padding-left:1.2rem}code{font-family:ui-monospace,monospace;font-size:.9em;overflow-wrap:anywhere}
pre{overflow:auto;font-size:.82rem;background:var(--bg);padding:.75rem;border-radius:var(--radius)}textarea{min-height:6rem;font-family:ui-monospace,monospace;font-size:.85rem}
nav{display:flex;flex-wrap:wrap;gap:.4rem .9rem;font-size:.9rem;margin-bottom:1rem}p[role=alert]{color:var(--danger);font-weight:600}p[role=status]{color:var(--muted)}
figure{margin:1rem 0;display:flex;justify-content:center}figure svg{max-width:100%;height:auto;background:#fff;padding:.5rem;border-radius:var(--radius)}
footer{max-width:30rem;width:100%;margin-top:1.25rem;font-size:.85rem;color:var(--muted);text-align:center}footer a{color:var(--muted)}footer p{margin:.25rem 0}
@media (prefers-reduced-motion:no-preference){button{transition:filter .15s}button:hover{filter:brightness(1.07)}}`;
// formTargets: origins a form on this page redirects to after it posts. Chrome applies form-action to those redirects, so
// the logout confirmation (to the app's post-logout URI) and the agent consent (to its callback) name them.
// client: the app whose branding this page wears (sign-in, consent, second factor); otherwise the realm's.
export function page(title, body, { script = '', turnstile = false, cookies = [], status = 200, formTargets = [], client = null, wide = false } = {}) {
    const formAction = ["'self'", ...new Set(formTargets.map(uri => new URL(uri).origin).filter(origin => origin !== 'null'))].join(' ');
    const headers = new Headers({
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        // Turnstile's origin is allowed only on pages that render the widget.
        'content-security-policy': `default-src 'self'; script-src 'self'${turnstile ? ' https://challenges.cloudflare.com' : ''}; frame-src ${turnstile ? 'https://challenges.cloudflare.com' : "'none'"}; style-src 'self'; connect-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
        'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff'
    });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${client?.id && /^[A-Za-z0-9_-]{1,200}$/.test(client.id) ? `<!--identity:client:${client.id}-->` : ''}<title>${escapeHtml(title)} · ${BRAND}</title><link rel="stylesheet" href="/assets/page.css">${HEAD}${HEADER}<main${wide ? ' class="wide"' : ''}>${body}</main>${FOOTER}${turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}${[script].flat().filter(Boolean).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join('')}</html>`, { status, headers });
}
// A signed-out visit to the account or second-factor pages. Only administrators can start a sign-in here (/login);
// everyone else signs in through an app, which leaves a session this page can use.
export const signedOutPage = () => page('Sign in to continue', `<h1>Sign in to see your account</h1>
<p>Your ${BRAND} account opens from the apps that use it. Sign in to one of them in this browser, then come back to this page.</p>
<p>Administrators can <a href="/login">sign in here</a>.</p>`, { status: 401 });
export const errorPage = (message, status = 400) => page('Sign-in error', `<h1>Sign-in could not finish</h1><p>${escapeHtml(message)}</p><p>Return to the app and start again.</p>`, { status });
// Fills the brand markers for the request's realm and, if the page names one, its app: name, logo or mark (with a
// dark variant), favicon, theme stylesheet and footer links. Everything inserted is escaped or an asset id.
export async function withBrand(response, env) {
    if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
    let html = await response.text();
    const clientId = /<!--identity:client:([A-Za-z0-9_-]{1,200})-->/.exec(html)?.[1];
    const client = clientId && env.REALM ? await env.DB.prepare('SELECT id,branding FROM clients WHERE id=? AND realm_id=?').bind(clientId, env.REALM.id).first() : null;
    const b = resolveBranding(env.REALM?.branding || {}, client ? JSON.parse(client.branding || '{}') : {});
    const name = escapeHtml(b.name || env.REALM?.display_name || 'Identity'), asset = id => `/assets/brand/${id}`;
    const logo = b.logo_light ? `<picture>${b.logo_dark ? `<source srcset="${asset(b.logo_dark)}" media="(prefers-color-scheme: dark)">` : ''}<img src="${asset(b.logo_light)}" alt="${name}"></picture>`
        : `${b.mark ? `<img class="mark" src="${asset(b.mark)}" alt="">` : ''}<span>${name}</span>`;
    const links = [b.privacy_url && `<a href="${escapeHtml(b.privacy_url)}">Privacy</a>`, b.terms_url && `<a href="${escapeHtml(b.terms_url)}">Terms</a>`,
        b.support_url ? `<a href="${escapeHtml(b.support_url)}">Help</a>` : b.support_email && `<a href="mailto:${escapeHtml(b.support_email)}">Help</a>`].filter(Boolean).join(' · ');
    const footer = links || b.legal_name || b.copy?.footer ? `<footer>${b.copy?.footer ? `<p>${escapeHtml(b.copy.footer)}</p>` : ''}${links ? `<p>${links}</p>` : ''}${b.legal_name ? `<p>© ${escapeHtml(b.legal_name)}</p>` : ''}</footer>` : '';
    const head = `<link rel="stylesheet" href="/assets/theme.css${client ? `?client=${encodeURIComponent(client.id)}` : ''}">${b.mark ? `<link rel="icon" href="${asset(b.mark)}">` : ''}`;
    html = html.replace('<html lang="en">', `<html lang="${b.locale || 'en'}">`).replaceAll(BRAND, name).replace(HEAD, head).replace(HEADER, `<header class="brand">${logo}</header>`).replace(FOOTER, footer);
    return new Response(html, { status: response.status, headers: response.headers });
}
