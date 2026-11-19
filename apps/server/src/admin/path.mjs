import { invariant } from '../lib/errors.mjs';

export function adminParts(path, api) {
    let parts;
    try { parts = path.slice(api ? 11 : 7).split('/').filter(Boolean).map(decodeURIComponent); }
    catch { invariant(false, 'invalid_request', 'Malformed admin path encoding.'); }
    invariant(parts.length <= 3, 'not_found', 'Admin endpoint not found.', 404);
    return parts;
}
