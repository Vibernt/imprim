// The probe's settings come from Wrangler vars. One identity client per isolate keeps discovery and JWKS cached.
import { createClient } from '../../../packages/imprim-client/index.mjs';

const clients = new Map();
const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function config(env) {
    const origin = String(env.ORIGIN || ''), workspaces = String(env.WORKSPACES || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin) || typeof env.ISSUER !== 'string' || typeof env.CLIENT_ID !== 'string' ||
        !workspaces.length || !workspaces.every(x => WORKSPACE.test(x)))
        throw Object.assign(new Error('Probe configuration is incomplete.'), { code: 'configuration' });
    return { origin, issuer: env.ISSUER, clientId: env.CLIENT_ID, workspaces, scope: env.SCOPE || 'probe.read', productResource: env.PRODUCT_RESOURCE === 'on' };
}

// Tests pass IDENTITY_FETCH to route client requests into the test issuer.
export function identity(env, cfg) {
    const options = { issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: env.APP_SECRET,
        resourcePrefixes: [`${cfg.origin}/w/`, resourceFor(cfg)] };
    if (env.IDENTITY_FETCH) return createClient({ ...options, fetch: env.IDENTITY_FETCH });
    const key = `${cfg.issuer} ${cfg.clientId} ${cfg.origin}`;
    const cached = clients.get(key);
    if (cached && cached.secret === env.APP_SECRET) return cached.client;
    const client = createClient(options);
    clients.set(key, { secret: env.APP_SECRET, client });
    return client;
}

const resourcePath = workspace => workspace === undefined ? '/mcp' : `/w/${workspace}/mcp`;
export const resourceFor = (cfg, workspace) => cfg.origin + resourcePath(workspace);
export const metadataUrlFor = (cfg, workspace) => `${cfg.origin}/.well-known/oauth-protected-resource${resourcePath(workspace)}`;

// The agent's client ID metadata document, so the scripted agent (agent/run.mjs) can use the device flow.
export const agentDocument = cfg => ({
    client_id: `${cfg.origin}/agent/client.json`,
    client_name: 'Imprim probe agent',
    redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    token_endpoint_auth_method: 'none'
});
