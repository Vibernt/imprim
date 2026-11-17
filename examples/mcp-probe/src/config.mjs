// The probe's settings come from Wrangler vars. One identity client per isolate keeps discovery and JWKS cached.
import { createClient } from '../../../packages/imprim-client/index.mjs';

const clients = new Map();
const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function config(env) {
    const origin = String(env.ORIGIN || ''), workspaces = String(env.WORKSPACES || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin) || typeof env.ISSUER !== 'string' || typeof env.CLIENT_ID !== 'string' ||
        !workspaces.length || !workspaces.every(x => WORKSPACE.test(x)))
        throw Object.assign(new Error('Probe configuration is incomplete.'), { code: 'configuration' });
    return { origin, issuer: env.ISSUER, clientId: env.CLIENT_ID, workspaces, scope: env.SCOPE || 'probe.read' };
}

// Tests pass IDENTITY_FETCH to route the client's discovery and JWKS requests into the test issuer.
export function identity(env, cfg) {
    const options = { issuer: cfg.issuer, clientId: cfg.clientId, resourcePrefixes: [`${cfg.origin}/w/`] };
    if (env.IDENTITY_FETCH) return createClient({ ...options, fetch: env.IDENTITY_FETCH });
    const key = `${cfg.issuer} ${cfg.clientId} ${cfg.origin}`;
    if (!clients.has(key)) clients.set(key, createClient(options));
    return clients.get(key);
}

export const resourceFor = (cfg, workspace) => `${cfg.origin}/w/${workspace}/mcp`;
export const metadataUrlFor = (cfg, workspace) => `${cfg.origin}/.well-known/oauth-protected-resource/w/${workspace}/mcp`;

// The agent's client ID metadata document, so the scripted agent (agent/run.mjs) can use the device flow.
export const agentDocument = cfg => ({
    client_id: `${cfg.origin}/agent/client.json`,
    client_name: 'Imprim probe agent',
    redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    token_endpoint_auth_method: 'none'
});
