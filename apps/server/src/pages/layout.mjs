export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Pages carry a fixed marker where the realm's name goes; the worker fills it for the request's realm (withBrand).
// Every user-supplied string is escaped, so `<` can never reach the output from input and the marker cannot be forged.
export const BRAND = '<!--identity:brand-->';
export const pageCss = `body{font:18px/1.6 system-ui,sans-serif;max-width:32rem;margin:10vh auto;padding:1.5rem;color:#18232b;background:#f7f7f3}
pre{overflow:auto;font-size:.85rem}textarea{box-sizing:border-box;width:100%;font:inherit}nav{overflow-wrap:anywhere}h1{line-height:1.2}label,input,button{display:block;margin:.7rem 0}input,button{font:inherit;padding:.6rem}input{box-sizing:border-box;width:100%}button{cursor:pointer}a{color:#174e76}p[role=alert]{color:#8b1919}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:600;font-size:1.1rem;margin-bottom:2rem}.brand img{width:2rem;height:2rem}`;
// formTargets: origins a form on this page redirects to after it posts. Chrome applies form-action to those redirects, so
// the logout confirmation (to the app's post-logout URI) and the agent consent (to its callback) name them.
export function page(title, body, { script = '', turnstile = false, cookies = [], status = 200, formTargets = [] } = {}) {
    const formAction = ["'self'", ...new Set(formTargets.map(uri => new URL(uri).origin).filter(origin => origin !== 'null'))].join(' ');
    const headers = new Headers({
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        // Turnstile's origin is allowed only on pages that render the widget.
        'content-security-policy': `default-src 'self'; script-src 'self'${turnstile ? ' https://challenges.cloudflare.com' : ''}; frame-src ${turnstile ? 'https://challenges.cloudflare.com' : "'none'"}; style-src 'self'; connect-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
        'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff'
    });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${BRAND}</title><link rel="stylesheet" href="/assets/page.css"><header class="brand">${BRAND}</header><main>${body}</main>${turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}${[script].flat().filter(Boolean).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join('')}</html>`, { status, headers });
}
export const errorPage = (message, status = 400) => page('Sign-in error', `<h1>Sign-in could not finish</h1><p>${escapeHtml(message)}</p><p>Return to the app and start again.</p>`, { status });
export async function withBrand(response, name) {
    if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
    const html = (await response.text()).replaceAll(BRAND, escapeHtml(name || 'Identity'));
    return new Response(html, { status: response.status, headers: response.headers });
}
