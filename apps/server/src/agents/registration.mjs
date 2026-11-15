import { invariant } from '../lib/errors.mjs';
import { readBody, json } from '../lib/http.mjs';
import { randomToken } from '../lib/crypto.mjs';
import { limitAgentAddress } from '../auth/rate-limit.mjs';
import { agentRedirect } from './uris.mjs';
import { fetchMetadata, metadataUrl, cacheLifetime } from './metadata-http.mjs';
import { validateKeys } from './client-auth.mjs';
import { realmId } from '../realms/realm.mjs';
const GRANTS = ['authorization_code','refresh_token','urn:ietf:params:oauth:grant-type:device_code'];
// Bidirectional overrides and control characters let a name render differently from what it says (S11).
export const displayName = value => value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim();
function validateMetadata(document, id) {
    invariant(document && typeof document === 'object' && !Array.isArray(document), 'invalid_client_metadata', 'Expected a metadata object.');
    invariant(!id || document.client_id === id, 'invalid_client_metadata', 'Metadata client_id must equal its URL.');
    invariant(typeof document.client_name === 'string' && displayName(document.client_name).length > 0 && document.client_name.length <= 200,
        'invalid_client_metadata', 'client_name required.');
    invariant(Array.isArray(document.redirect_uris) && document.redirect_uris.length > 0 && document.redirect_uris.length <= 20,
        'invalid_client_metadata', 'redirect_uris required.');
    document.redirect_uris.forEach(agentRedirect);
    invariant([undefined, 'none', 'private_key_jwt'].includes(document.token_endpoint_auth_method), 'invalid_client_metadata', 'Use token_endpoint_auth_method none or private_key_jwt.');
    invariant(!Object.hasOwn(document, 'client_secret'), 'invalid_client_metadata', 'Shared client secrets are not supported.');
    const keys = validateKeys(document, id);
    invariant(document.response_types === undefined || (Array.isArray(document.response_types) && document.response_types.length === 1 && document.response_types[0] === 'code'), 'invalid_client_metadata', 'Only code responses are supported.');
    // The device grant is never a default: it must be declared (S1). RFC 7591 defaults to authorization_code alone.
    const grants = document.grant_types ?? ['authorization_code','refresh_token'];
    invariant(Array.isArray(grants) && grants.length > 0 && grants.every(x => GRANTS.includes(x)) && new Set(grants).size === grants.length, 'invalid_client_metadata', 'Unsupported grant types.');
    return { client_id: id, client_name: displayName(document.client_name), redirect_uris: document.redirect_uris,
        token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: grants, ...keys };
}
export async function resolveAgent(env, id) {
    invariant(typeof id === 'string' && id.length <= 2048, 'invalid_client', 'Agent client_id required.');
    if (!id.startsWith('https://')) {
        const row = await env.DB.prepare('SELECT * FROM agent_clients WHERE id=? AND realm_id=? AND last_used>?').bind(id, realmId(env), Date.now() - 30 * 86400000).first();
        invariant(row, 'invalid_client', 'Unknown or unused expired agent registration.');
        return validateMetadata(JSON.parse(row.metadata), id);
    }
    metadataUrl(id);
    const cached = await env.DB.prepare('SELECT * FROM agent_metadata_cache WHERE id=? AND expires_at>?').bind(id, Date.now()).first();
    if (cached) return validateMetadata(JSON.parse(cached.metadata), id);
    const { document, headers } = await fetchMetadata(id), metadata = validateMetadata(document, id);
    const lifetime = cacheLifetime(headers);
    await env.DB.prepare('INSERT OR REPLACE INTO agent_metadata_cache(id,metadata,expires_at) VALUES(?,?,?)').bind(id, JSON.stringify(metadata), Date.now() + lifetime).run();
    await env.DB.prepare('DELETE FROM agent_metadata_cache WHERE id IN (SELECT id FROM agent_metadata_cache ORDER BY expires_at DESC LIMIT -1 OFFSET 2000)').run();
    return metadata;
}
export async function registerAgent(request, env) {
    await limitAgentAddress(env, request, 'registration', 10);
    invariant(!request.headers.has('authorization'), 'invalid_client', 'Registration accepts public clients without credentials.');
    const body = await readBody(request);
    invariant(!body.client_id, 'invalid_client_metadata', 'Registration assigns the client ID.');
    const id = 'agent_' + randomToken(), metadata = validateMetadata({ ...body, client_id: id }, id);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO agent_clients(id,metadata,created,last_used,realm_id) VALUES(?,?,?,?,?)').bind(id, JSON.stringify(metadata), now, now, realmId(env)).run();
    return json({ ...metadata, client_id_issued_at: Math.floor(now / 1000) }, 201);
}
