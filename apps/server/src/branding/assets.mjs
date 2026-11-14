// Brand assets: uploaded by admins, checked by magic bytes, SVGs refused if they carry script, event handlers,
// foreign content, entities or external references. Served content-addressed with a sandboxing CSP, and only ever
// shown through <img>, so even a hostile SVG could not run script on the identity origin.
import { invariant } from '../lib/errors.mjs';
import { from64 } from '../lib/crypto.mjs';
import { realmId } from '../realms/realm.mjs';
export const MAX_ASSET = 262144;
const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
export function checkAsset(contentType, bytes) {
    invariant(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'].includes(contentType), 'invalid_request', 'Use SVG, PNG, JPEG or WebP.');
    invariant(bytes.length > 0 && bytes.length <= MAX_ASSET, 'invalid_request', 'Assets are at most 256 KiB.');
    if (contentType !== 'image/svg+xml') {
        invariant(MAGIC[contentType].every((byte, i) => bytes[i] === byte), 'invalid_request', 'The file does not match its type.');
        return;
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invariant(false, 'invalid_request', 'SVG must be UTF-8.'); }
    invariant(/<svg[\s>]/i.test(text), 'invalid_request', 'Not an SVG.');
    invariant(!/<\s*(script|foreignObject|iframe|object|embed|image|use|a|animate|set|style)[\s>/]/i.test(text) && !/\bon[a-z]+\s*=/i.test(text) &&
        !/<!(ENTITY|DOCTYPE)/i.test(text) && !/(javascript|data|https?|file)\s*:/i.test(text.replace(/xmlns(:\w+)?\s*=\s*["'][^"']*["']/gi, '')) && !/url\s*\(/i.test(text),
        'invalid_request', 'SVG may not contain script, event handlers, styles, links, foreign content, entities or external references.');
}
export async function storeAsset(env, contentType, base64) {
    let bytes;
    try { bytes = from64(String(base64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); } catch { invariant(false, 'invalid_request', 'data must be base64.'); }
    checkAsset(contentType, bytes);
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT OR IGNORE INTO brand_assets(id,realm_id,content_type,data,created) VALUES(?,?,?,?,?)').bind(id, realmId(env), contentType, bytes, Date.now()).run();
    return { id, url: `/assets/brand/${id}` };
}
export async function serveAsset(env, id) {
    invariant(/^[0-9a-f]{64}$/.test(id), 'not_found', 'Asset not found.', 404);
    const row = await env.DB.prepare('SELECT content_type,data FROM brand_assets WHERE realm_id=? AND id=?').bind(realmId(env), id).first();
    invariant(row, 'not_found', 'Asset not found.', 404);
    return new Response(row.data, { headers: { 'content-type': row.content_type, 'cache-control': 'public, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } });
}
export async function assetExists(env, id) {
    return Boolean(await env.DB.prepare('SELECT 1 FROM brand_assets WHERE realm_id=? AND id=?').bind(realmId(env), id).first());
}
