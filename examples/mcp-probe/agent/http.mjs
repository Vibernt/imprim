export async function read(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return null; }
}
export function failure({ status, body }) {
    const code = typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? ` ${body.error}` : '';
    return `HTTP ${status}${code}`;
}
export async function form(url, body, headers = {}) {
    const response = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
    return { status: response.status, body: await read(response) };
}
export function claimsOf(jwt) {
    let claims;
    try { claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')); } catch { /* Do not print a malformed payload. */ }
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('The token response does not contain valid JWT claims.');
    return claims;
}

export function sameOrigin(value, origin) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password && !url.hash;
    } catch { return false; }
}

export async function discover(resource, check) {
    const challenge = await fetch(resource, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: '{}' });
    const header = challenge.headers.get('www-authenticate') || '';
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    if (!check('the MCP server challenges an unauthenticated call', challenge.status === 401 && sameOrigin(metadataUrl, new URL(resource).origin),
        `expected a 401 with same-origin metadata, got HTTP ${challenge.status}`)) return null;
    const metadataResponse = await fetch(metadataUrl, { redirect: 'manual' });
    const metadata = await read(metadataResponse);
    if (!check('resource metadata names this exact resource', metadataResponse.ok && metadata?.resource === resource,
        `HTTP ${metadataResponse.status}`)) return null;
    const issuer = metadata?.authorization_servers?.[0];
    if (!check('resource metadata names an HTTPS issuer', typeof issuer === 'string' &&
        /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(issuer))) return null;
    const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { redirect: 'manual' });
    const server = await read(response);
    if (!check('authorization server metadata comes from the named issuer', response.ok && server?.issuer === issuer,
        `HTTP ${response.status}`)) return null;
    if (!check('the token endpoint belongs to the named issuer', sameOrigin(server.token_endpoint, issuer))) return null;
    if (!check('the issuer accepts client ID metadata documents', server.client_id_metadata_document_supported === true)) return null;
    return { issuer, server };
}

async function mcp(url, token, method, params, id) {
    const message = id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
    return fetch(url, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify(message) });
}
export async function whoami(token, url) {
    const opened = await mcp(url, token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'imprim-probe-agent', version: '1.0.0' } }, 1);
    if (opened.status !== 200) return { status: opened.status };
    await mcp(url, token, 'notifications/initialized', {});
    const called = await mcp(url, token, 'tools/call', { name: 'whoami', arguments: {} }, 2);
    return { status: called.status, facts: called.status === 200 ? (await read(called))?.result?.structuredContent : null };
}
