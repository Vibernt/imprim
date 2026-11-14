// The theme stylesheet for a realm (and optionally one app), from tokens only. Served from the identity host because
// CSP allows style-src 'self' and no inline styles.
import { FONTS, brandingFor } from './tokens.mjs';
const vars = t => `--primary:${t.primary};--primary-text:${t.primary_text};--bg:${t.background};--surface:${t.surface};--text:${t.text};--muted:${t.muted};--border:${t.border}`;
export function themeCss(branding) {
    const light = branding.theme, dark = { ...light, ...branding.theme_dark };
    return `:root{${vars(light)};--radius:${light.radius}px;--font:${FONTS[light.font] || FONTS.system};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars(dark)}}}`;
}
export async function themeResponse(env, url) {
    const clientId = url.searchParams.get('client');
    const client = clientId && /^[A-Za-z0-9_-]{1,200}$/.test(clientId) ? await env.DB.prepare('SELECT branding FROM clients WHERE id=? AND realm_id=?').bind(clientId, env.REALM.id).first() : null;
    return new Response(themeCss(brandingFor(env, client)), { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
