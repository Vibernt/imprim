import { invariant } from '../lib/errors.mjs';
export function cleanUrl(value, code = 'invalid_request') {
    let url;
    try { url = new URL(value); } catch { invariant(false, code, 'Invalid URL.'); }
    invariant(typeof value === 'string' && value.length <= 2048 && !/[\s\\\x00-\x1f\x7f]/.test(value) &&
        !url.username && !url.password && !url.hash, code, 'Invalid URL.');
    return url;
}
// One route, one audience: a resource must be in the single canonical form, so `/mcp`, `/mcp/`, `/%6Dcp` and
// `/%2a` never name the same route twice. Prefixes may end in `/`; resources may not.
export function resourceUrl(value, kind = 'resource') {
    const url = cleanUrl(value, 'invalid_target');
    invariant(url.protocol === 'https:' && !url.search && url.href === value && !/%(?:2f|5c|2e|00)/i.test(url.pathname),
        'invalid_target', 'Resource must be a canonical HTTPS URL without query or fragment.');
    try { decodeURIComponent(url.pathname); } catch { invariant(false, 'invalid_target', 'Invalid resource path encoding.'); }
    invariant(!/%(?:[0-9a-f][a-f]|[a-f][0-9a-f])/.test(url.pathname) && !/%(?:4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A]|3[0-9]|2D|5F|7E)/.test(url.pathname),
        'invalid_target', 'Resource must not percent-encode unreserved characters or use lowercase escapes.');
    invariant(!url.pathname.includes('//') && (kind === 'prefix' || url.pathname === '/' || !url.pathname.endsWith('/')),
        'invalid_target', 'Resource must not contain empty path segments or end with a slash.');
    return url;
}
export function underPrefix(resource, prefix) {
    const r = resourceUrl(resource), p = resourceUrl(prefix, 'prefix');
    return r.origin === p.origin && (r.pathname === p.pathname || r.pathname.startsWith(p.pathname.endsWith('/') ? p.pathname : p.pathname + '/'));
}
export function agentRedirect(uri) {
    const url = cleanUrl(uri, 'invalid_redirect_uri');
    invariant(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)),
        'invalid_redirect_uri', 'Use HTTPS or an HTTP loopback redirect.');
    return url;
}
export function matchRedirect(agent, uri) {
    const url = agentRedirect(uri);
    invariant(agent.redirect_uris.some(registered => {
        if (registered === uri) return true;
        const candidate = agentRedirect(registered);
        // Only HTTP loopback ports vary. Host, path, and query remain exact.
        if (url.protocol !== 'http:' || candidate.protocol !== 'http:') return false;
        const withoutPort = value => value.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost))(?::[0-9]+)?(?=[/?]|$)/i, '$1');
        return withoutPort(registered) === withoutPort(uri);
    }), 'invalid_request', 'Redirect URI is not registered.');
}
export function workspace(resource) {
    const path = new URL(resource).pathname;
    const match = /\/w\/([^/]+)(?:\/|$)/.exec(path);
    return match ? decodeURIComponent(match[1]) : path;
}
