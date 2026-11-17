// imprim-probe: a minimal MCP server that accepts agents through Imprim, for live tests with real AI clients.
// It logs every request (method, path, status, user agent, how it authenticated) so a test shows exactly which
// discovery paths each client tries. See ../README.md.
import { config, identity, agentDocument, resourceFor } from './config.mjs';
import { mcp } from './mcp.mjs';
import { backchannel } from './events.mjs';
import { CORS, log } from './http.mjs';

const MCP_PATH = /^\/w\/([a-z0-9][a-z0-9-]{0,39})\/mcp$/;
const METADATA_PATH = /^\/\.well-known\/oauth-protected-resource\/w\/([a-z0-9][a-z0-9-]{0,39})\/mcp$/;

const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

async function route(request, env, url, note) {
    const cfg = config(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '600' } });
    const path = url.pathname;
    if (path === '/' && request.method === 'GET')
        return text(`Imprim probe. MCP endpoints: ${cfg.workspaces.map(w => resourceFor(cfg, w)).join(', ')}\n`);
    if (path === '/agent/client.json' && request.method === 'GET')
        return Response.json(agentDocument(cfg), { headers: { 'cache-control': 'public, max-age=300' } });
    if (path === '/callback') return text('This test app has no human sign-in.\n');
    if (path === '/backchannel') return backchannel(request, env, cfg, note);

    let match = METADATA_PATH.exec(path);
    if (match && cfg.workspaces.includes(match[1]) && request.method === 'GET') {
        note.workspace = match[1];
        const metadata = identity(env, cfg).protectedResourceMetadata({ resource: resourceFor(cfg, match[1]), scopes: [cfg.scope] });
        return Response.json(metadata, { headers: { ...CORS, 'cache-control': 'public, max-age=300' } });
    }
    match = MCP_PATH.exec(path);
    if (match && cfg.workspaces.includes(match[1])) {
        note.workspace = match[1];
        return mcp(request, env, cfg, match[1], note);
    }
    // Logged on purpose: which well-known paths a client looks for is part of what the test records.
    note.unknown = true;
    return text('Not found.\n', 404);
}

export default {
    async fetch(request, env) {
        const started = Date.now(), url = new URL(request.url), note = {};
        let response;
        try { response = await route(request, env, url, note); }
        catch (error) {
            note.error = error?.code || 'server_error';
            response = Response.json({ error: 'server_error' }, { status: 500 });
        }
        log({ method: request.method, path: url.pathname, status: response.status, ms: Date.now() - started,
            ua: (request.headers.get('user-agent') || '').slice(0, 160), ...note });
        return response;
    }
};
