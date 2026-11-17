// One workspace's MCP endpoint (Streamable HTTP, JSON responses only). Every call is authenticated: verify the token
// for this exact resource, refuse revoked grants and replayed DPoP proofs, then intersect scopes with the role.
import { identity, resourceFor, metadataUrlFor } from './config.mjs';
import { wwwAuthenticate } from '../../../packages/imprim-client/index.mjs';
import { CORS } from './http.mjs';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_BODY = 65536;
// The probe has one role, and every member holds it: it allows the configured scope. A real app looks up the
// person's current membership and role in this workspace here.
const roleScopes = cfg => [cfg.scope];

const WHOAMI = {
    name: 'whoami',
    description: 'Shows which person, agent and grant this connection uses, and the scopes the app allows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

function challenge(cfg, workspace, error, status = 401) {
    return new Response(null, { status, headers: { ...CORS, 'www-authenticate': wwwAuthenticate({ resourceMetadataUrl: metadataUrlFor(cfg, workspace), error }) } });
}
const reply = (id, body) => Response.json({ jsonrpc: '2.0', id, ...body }, { headers: CORS });
const rpcError = (id, code, message) => reply(id ?? null, { error: { code, message } });

export async function mcp(request, env, cfg, workspace, note) {
    // Authenticate before anything else, so a client that opens with GET still receives the challenge.
    const resource = resourceFor(cfg, workspace);
    const header = request.headers.get('authorization') || '';
    const match = /^(Bearer|DPoP) ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    note.auth = match ? match[1].toLowerCase() : header ? 'malformed' : 'none';
    if (!match) return challenge(cfg, workspace, header ? 'invalid_request' : undefined);

    let claims;
    try {
        // The audience is the route being served, never anything the caller sent.
        const dpop = match[1] === 'DPoP' ? { proof: request.headers.get('dpop') || '', method: 'POST', url: resource } : undefined;
        claims = await identity(env, cfg).verifyAccessToken(match[2], { audience: resource, dpop });
        if (match[1] === 'DPoP' && !claims.cnf?.jkt) throw Object.assign(new Error('DPoP scheme with an unbound token.'), { code: 'invalid_token' });
    } catch (error) {
        note.reject = error?.code || 'invalid_token';
        return challenge(cfg, workspace, 'invalid_token');
    }
    note.client_id = claims.client_id;
    note.grant_id = claims.grant_id;

    if (claims.dpop_jti) {
        const now = Date.now();
        await env.DB.prepare('DELETE FROM dpop_seen WHERE expires_at<?').bind(now).run();
        const seen = await env.DB.prepare('INSERT INTO dpop_seen(jti,expires_at) VALUES(?,?) ON CONFLICT(jti) DO NOTHING').bind(claims.dpop_jti, now + 600000).run();
        if (seen.meta.changes === 0) { note.reject = 'dpop_replay'; return challenge(cfg, workspace, 'invalid_token'); }
    }
    const revoked = await env.DB.prepare("SELECT 1 FROM events WHERE kind='revocation' AND grant_id=? AND sub=? AND resource=?")
        .bind(claims.grant_id, claims.sub, resource).first();
    if (revoked) { note.reject = 'revoked'; return challenge(cfg, workspace, 'invalid_token'); }

    const allowed = claims.scope.split(' ').filter(scope => roleScopes(cfg).includes(scope));
    if (!allowed.includes(cfg.scope)) { note.reject = 'insufficient_scope'; return challenge(cfg, workspace, 'insufficient_scope', 403); }

    // No server-sent event stream: GET and DELETE are not offered (the Streamable HTTP transport allows 405).
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...CORS, allow: 'POST, OPTIONS' } });
    if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return new Response(null, { status: 415, headers: CORS });
    const text = await request.text();
    if (text.length > MAX_BODY) return new Response(null, { status: 413, headers: CORS });
    let message;
    try { message = JSON.parse(text); } catch { return rpcError(null, -32700, 'Parse error.'); }
    if (Array.isArray(message)) return rpcError(null, -32600, 'Batches are not supported.');
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid request.');
    note.rpc = message.method;
    // A notification (no id) gets no body.
    if (message.id === undefined) return new Response(null, { status: 202, headers: CORS });

    switch (message.method) {
        case 'initialize': {
            const asked = message.params?.protocolVersion;
            note.protocol = typeof asked === 'string' ? asked.slice(0, 20) : 'none';
            return reply(message.id, { result: {
                protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
                capabilities: { tools: {} },
                serverInfo: { name: 'imprim-probe', version: '1.0.0' },
                instructions: 'A test server for Imprim. Call whoami to see who this connection acts for.'
            } });
        }
        case 'ping': return reply(message.id, { result: {} });
        case 'tools/list': return reply(message.id, { result: { tools: [WHOAMI] } });
        case 'tools/call': {
            if (message.params?.name !== 'whoami') return rpcError(message.id, -32602, 'Unknown tool.');
            const facts = {
                workspace, person: claims.sub, agent: claims.client_id, grant: claims.grant_id,
                scope: claims.scope, allowed, audience: claims.aud,
                issued_at: claims.iat, expires_at: claims.exp, grant_issued_at: claims.grant_issued_at ?? null,
                dpop_bound: Boolean(claims.cnf?.jkt), act: claims.act ?? null
            };
            return reply(message.id, { result: { content: [{ type: 'text', text: JSON.stringify(facts, null, 2) }], structuredContent: facts, isError: false } });
        }
        default: return rpcError(message.id, -32601, 'Method not found.');
    }
}
