// The brand stylesheet for a realm (and optionally one app): the Fire look's custom properties, from tokens only.
// Served from the identity host because CSP allows style-src 'self' and no inline styles.
import { brandingFor } from './tokens.mjs';
import { lookCss } from './look.mjs';
export const themeCss = branding => lookCss(branding.look);
export async function themeResponse(env, url) {
    const clientId = url.searchParams.get('client');
    const client = clientId && /^[A-Za-z0-9_-]{1,200}$/.test(clientId) ? await env.DB.prepare('SELECT branding FROM clients WHERE id=? AND realm_id=?').bind(clientId, env.REALM.id).first() : null;
    return new Response(themeCss(brandingFor(env, client)), { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
