// Bearer tokens only, no cookies, so a browser-based MCP client may call from any origin.
export const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, dpop, mcp-protocol-version, mcp-session-id',
    'access-control-expose-headers': 'www-authenticate, mcp-session-id'
};

// One line per request, for `wrangler tail`. Never a token, a query string or a request body.
export function log(entry) {
    console.log(JSON.stringify({ probe: 1, ...entry }));
}
