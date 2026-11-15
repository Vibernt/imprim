// Brand assets: uploaded by admins, checked by magic bytes, SVGs checked against an allowlist. Served
// content-addressed with a sandboxing CSP and nosniff, and only ever shown through <img>, so even an SVG that slipped
// past the allowlist could not run script on the identity origin.
import { invariant } from '../lib/errors.mjs';
import { from64 } from '../lib/crypto.mjs';
import { realmId } from '../realms/realm.mjs';
export const MAX_ASSET = 262144;
const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
// SVGs are checked against an allowlist, not cleaned: plain shapes, paths and gradients, presentation attributes, no
// prefixed names, no processing instructions, doctype, CDATA, entities, links or references other than url(#id).
const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient',
    'radialGradient', 'stop', 'title', 'desc', 'clipPath', 'mask']);
const SVG_ATTRIBUTES = new Set(['xmlns', 'version', 'id', 'class', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'fx', 'fy', 'd', 'points', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
    'gradientTransform', 'spreadMethod', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits', 'preserveAspectRatio',
    'role', 'aria-label', 'aria-hidden', 'focusable']);
const svgFail = () => invariant(false, 'invalid_request', 'SVG may contain only shapes, paths, gradients, clip paths and masks with presentation attributes: no script, styles, links, prefixed names, entities or external references.');
function checkSvg(text) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/.test(text)) svgFail();
    let rest = text.replace(/^﻿?\s*<\?xml(\s+version\s*=\s*("1\.[01]"|'1\.[01]'))?(\s+encoding\s*=\s*("utf-8"|'utf-8'))?(\s+standalone\s*=\s*("(yes|no)"|'(yes|no)'))?\s*\?>/i, '');
    rest = rest.replace(/<!--(?:(?!--)[\s\S])*-->/g, '');
    if (/<[!?]/.test(rest)) svgFail();
    let root = null;
    rest = rest.replace(/<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g, (_, close, name, attributes) => {
        if (!SVG_ELEMENTS.has(name)) svgFail();
        root ??= name;
        if (close && attributes) svgFail();
        for (const [, attribute, quoted] of attributes.matchAll(/\s+([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g)) {
            const value = quoted.slice(1, -1);
            if (attribute === 'xmlns' || attribute === 'xmlns:xlink') { if (value !== (attribute === 'xmlns' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xlink')) svgFail(); continue; }
            if (!SVG_ATTRIBUTES.has(attribute) || /[&\\:<>]/.test(value)) svgFail();
            if (/url/i.test(value) && !/^url\(#[A-Za-z][A-Za-z0-9_-]{0,63}\)$/.test(value)) svgFail();
        }
        return '';
    });
    if (root !== 'svg' || /[<>]/.test(rest) || /&(?!(amp|lt|gt|quot|apos);)/.test(rest)) svgFail();
}
export function checkAsset(contentType, bytes) {
    invariant(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'].includes(contentType), 'invalid_request', 'Use SVG, PNG, JPEG or WebP.');
    invariant(bytes.length > 0 && bytes.length <= MAX_ASSET, 'invalid_request', 'Assets are at most 256 KiB.');
    if (contentType !== 'image/svg+xml') {
        invariant(MAGIC[contentType].every((byte, i) => bytes[i] === byte) && (contentType !== 'image/webp' || String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'),
            'invalid_request', 'The file does not match its type.');
        return;
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invariant(false, 'invalid_request', 'SVG must be UTF-8.'); }
    checkSvg(text);
}
// Decodes strict base64 and checks the asset. The caller stores it with storeStatement, in the same batch as its audit.
export async function prepareAsset(contentType, base64) {
    invariant(typeof base64 === 'string' && base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), 'invalid_request', 'data must be base64.');
    let bytes;
    try { bytes = from64(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); } catch { invariant(false, 'invalid_request', 'data must be base64.'); }
    checkAsset(contentType, bytes);
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    return { id, contentType, bytes, url: `/assets/brand/${id}` };
}
export const storeStatement = (env, asset) => env.DB.prepare('INSERT OR IGNORE INTO brand_assets(id,realm_id,content_type,data,created) VALUES(?,?,?,?,?)')
    .bind(asset.id, realmId(env), asset.contentType, asset.bytes, Date.now());
export async function serveAsset(env, id) {
    invariant(/^[0-9a-f]{64}$/.test(id), 'not_found', 'Asset not found.', 404);
    const row = await env.DB.prepare('SELECT content_type,data FROM brand_assets WHERE realm_id=? AND id=?').bind(realmId(env), id).first();
    invariant(row, 'not_found', 'Asset not found.', 404);
    return new Response(new Uint8Array(row.data), { headers: { 'content-type': row.content_type, 'cache-control': 'public, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } });
}
export async function assetExists(env, id, realm = realmId(env)) {
    return Boolean(await env.DB.prepare('SELECT 1 FROM brand_assets WHERE realm_id=? AND id=?').bind(realm, id).first());
}
