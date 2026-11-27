import { msg } from '../i18n/index.mjs';
import { b64url, from64 } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
import { validSub } from '../lib/http.mjs';

export function workspaceTarget(value) {
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { invariant(false, 'invalid_request', msg('Invalid path parameter.')); }
    invariant(validSub(decoded), 'invalid_request', msg('Invalid path parameter.'));
    return decoded;
}

export function memberCursor(value) {
    if (value === undefined) return null;
    let cursor;
    invariant(value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value), 'invalid_request', msg('Invalid cursor.'));
    try { cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(from64(value))); } catch { cursor = null; }
    invariant(Array.isArray(cursor) && cursor.length === 2 && Number.isSafeInteger(cursor[0]) && validSub(cursor[1]),
        'invalid_request', msg('Invalid cursor.'));
    return cursor;
}

export function memberPage(rows, size) {
    const page = rows.slice(0, size), last = page.at(-1);
    return { rows: page,
        after: rows.length > size ? b64url(new TextEncoder().encode(JSON.stringify([last.created, last.sub]))) : null };
}
