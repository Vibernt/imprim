// private_key_jwt for agents that publish keys in their client ID metadata document (RFC 7523, RFC 7591 jwks/jwks_uri).
// A claimed client_id string authenticates nothing (S1); a signed, single-use assertion does.
import { invariant } from '../lib/errors.mjs';
import { from64, sha256 } from '../lib/crypto.mjs';
import { fetchJson, cacheLifetime, metadataUrl } from './metadata-http.mjs';
const ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const algorithms = { ES256: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }, RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } };
export function validateKeys(document, id) {
    if (document.token_endpoint_auth_method !== 'private_key_jwt') {
        invariant(!document.jwks && !document.jwks_uri, 'invalid_client_metadata', 'Keys require token_endpoint_auth_method private_key_jwt.');
        return {};
    }
    invariant(id?.startsWith('https://'), 'invalid_client_metadata', 'Only metadata documents can use private_key_jwt.');
    invariant(Boolean(document.jwks) !== Boolean(document.jwks_uri), 'invalid_client_metadata', 'Provide exactly one of jwks or jwks_uri.');
    if (document.jwks) {
        invariant(Array.isArray(document.jwks.keys) && document.jwks.keys.length > 0 && document.jwks.keys.length <= 10, 'invalid_client_metadata', 'jwks needs 1 to 10 keys.');
        return { token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: document.jwks.keys.map(publicKey) } };
    }
    const { url } = metadataUrl(document.jwks_uri);
    invariant(url.host === new URL(id).host, 'invalid_client_metadata', 'jwks_uri must be on the client ID host.');
    return { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: document.jwks_uri };
}
function publicKey(key) {
    invariant(key && typeof key === 'object' && typeof key.kid === 'string' && key.kid.length <= 200 && !key.d && !key.p && !key.k,
        'invalid_client_metadata', 'Each key needs a kid and must be public.');
    invariant((key.kty === 'EC' && key.crv === 'P-256' && typeof key.x === 'string' && typeof key.y === 'string') ||
        (key.kty === 'RSA' && typeof key.n === 'string' && key.n.length >= 342 && key.e === 'AQAB'), 'invalid_client_metadata', 'Keys must be P-256 or RSA-2048+.');
    const { kty, crv, x, y, n, e, kid } = key;
    return Object.fromEntries(Object.entries({ kty, crv, x, y, n, e, kid }).filter(([, v]) => v !== undefined));
}
async function agentKeys(env, agent) {
    if (agent.jwks) return agent.jwks.keys;
    const cacheId = 'jwks:' + agent.jwks_uri;
    const cached = await env.DB.prepare('SELECT metadata FROM agent_metadata_cache WHERE id=? AND expires_at>?').bind(cacheId, Date.now()).first();
    if (cached) return JSON.parse(cached.metadata).keys;
    const { document, headers } = await fetchJson(agent.jwks_uri, ['application/json', 'application/jwk-set+json']);
    invariant(Array.isArray(document?.keys) && document.keys.length > 0 && document.keys.length <= 10, 'invalid_client', 'Agent JWKS is invalid.', 401);
    const keys = document.keys.map(key => { try { return publicKey(key); } catch { invariant(false, 'invalid_client', 'Agent JWKS is invalid.', 401); } });
    await env.DB.prepare('INSERT OR REPLACE INTO agent_metadata_cache(id,metadata,expires_at) VALUES(?,?,?)')
        .bind(cacheId, JSON.stringify({ keys }), Date.now() + cacheLifetime(headers)).run();
    return keys;
}
// Verifies the assertion for a key-bound agent; refuses an assertion from an agent that published no keys.
export async function authenticateAgent(env, agent, body, endpoint) {
    const supplied = body.client_assertion !== undefined || body.client_assertion_type !== undefined;
    if (agent.token_endpoint_auth_method !== 'private_key_jwt') {
        invariant(!supplied, 'invalid_client', 'This agent publishes no keys.', 401);
        return false;
    }
    const fail = message => invariant(false, 'invalid_client', message, 401);
    if (body.client_assertion_type !== ASSERTION || typeof body.client_assertion !== 'string' || body.client_assertion.length > 8192) fail('A private_key_jwt client assertion is required.');
    const parts = body.client_assertion.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) fail('Malformed client assertion.');
    let header, claims;
    try { [header, claims] = parts.slice(0, 2).map(part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(from64(part)))); }
    catch { fail('Malformed client assertion.'); }
    const algorithm = algorithms[header?.alg];
    if (!algorithm || typeof header.kid !== 'string' || header.jku || header.jwk || header.x5u || header.crit) fail('Unsupported client assertion header.');
    const jwk = (await agentKeys(env, agent)).find(key => key.kid === header.kid && (header.alg === 'ES256' ? key.kty === 'EC' : key.kty === 'RSA'));
    if (!jwk) fail('Unknown client assertion key.');
    let valid = false;
    try {
        const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);
        valid = await crypto.subtle.verify(algorithm, key, from64(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    } catch { fail('Invalid client assertion signature.'); }
    if (!valid) fail('Invalid client assertion signature.');
    const now = Math.floor(Date.now() / 1000), audiences = [env.ISSUER, `${env.ISSUER}${endpoint}`];
    const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    if (claims?.iss !== agent.client_id || claims.sub !== agent.client_id || !aud.some(value => audiences.includes(value)) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp > now + 300 ||
        (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > now + 60)) ||
        typeof claims.jti !== 'string' || claims.jti.length === 0 || claims.jti.length > 200) fail('Invalid client assertion claims.');
    const claimed = await env.DB.prepare('INSERT INTO agent_assertions(jti_hash,expires_at) VALUES(?,?) ON CONFLICT(jti_hash) DO NOTHING RETURNING jti_hash')
        .bind(await sha256(`${agent.client_id}\n${claims.jti}`), (claims.exp + 60) * 1000).first();
    if (!claimed) fail('Client assertion already used.');
    return true;
}
