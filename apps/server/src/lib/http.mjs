import { invariant } from './errors.mjs';
export const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
export function redirect(location, cookies = []) {
    const response = new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
    for (const cookie of cookies) response.headers.append('set-cookie', cookie);
    return response;
}
export function uniqueParams(params, repeated = []) {
    const entries = Object.fromEntries(params);
    for (const key of new Set(params.keys())) {
        if (!repeated.includes(key)) invariant(params.getAll(key).length === 1, 'invalid_request', 'Duplicate parameters are not allowed.');
    }
    for (const key of repeated) entries[key] = params.getAll(key);
    return entries;
}
export const validSub = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
export async function readBody(request, format = 'json', limit = 16384, repeated = []) {
    const type = request.headers.get('content-type')?.split(';')[0].trim();
    invariant(type === (format === 'json' ? 'application/json' : 'application/x-www-form-urlencoded'), 'invalid_request', 'Unsupported content type.', 415);
    // Bound streamed input; do not trust Content-Length supplied by the caller.
    const reader = request.body?.getReader(), chunks = []; let size = 0;
    if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); invariant(false, 'invalid_request', 'Request body too large.', 413); }
        chunks.push(value);
    }
    const text = await new Blob(chunks).text();
    try {
        if (format === 'form') return uniqueParams(new URLSearchParams(text), repeated);
        const value = JSON.parse(text);
        invariant(value && typeof value === 'object' && !Array.isArray(value), 'invalid_request', 'Expected an object.');
        return value;
    } catch (error) {
        if (error.code) throw error;
        invariant(false, 'invalid_request', 'Malformed request body.');
    }
}
export const tokenShape = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function issuer(env) {
    invariant(typeof env.ISSUER === 'string' && /^https:\/\/[^/?#]+$/.test(env.ISSUER), 'issuer_config', 'ISSUER must be an HTTPS origin.', 503);
    invariant(new URL(env.ISSUER).origin === env.ISSUER, 'issuer_config', 'ISSUER must be a canonical origin.', 503);
    return env.ISSUER;
}
