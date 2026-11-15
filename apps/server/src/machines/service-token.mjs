// client_credentials for registered service clients: a machine acting as itself for one app's resources, never for
// a person. Authentication is private_key_jwt only. The token's sub is `service:<id>`; the app still authorises.
import { invariant } from '../lib/errors.mjs';
import { json } from '../lib/http.mjs';
import { authenticateAgent } from '../agents/client-auth.mjs';
import { ownerOf } from '../agents/policy.mjs';
import { agentSettings } from '../agents/settings.mjs';
import { underPrefix } from '../agents/uris.mjs';
import { signAgentJwt } from '../agents/grants.mjs';
import { realmId } from '../realms/realm.mjs';
import { verifyDpop } from './dpop.mjs';
const SERVICE_TOKEN_SECONDS = 60;
const serviceSubject = id => `service:${id}`;
async function activeService(env, id) {
    invariant(typeof id === 'string' && /^[a-z0-9-]{3,60}$/.test(id), 'invalid_client', 'Unknown service client.', 401);
    const service = await env.DB.prepare("SELECT * FROM service_clients WHERE id=? AND realm_id=? AND status='active'").bind(id, realmId(env)).first();
    invariant(service, 'invalid_client', 'Unknown or disabled service client.', 401);
    return service;
}
export async function serviceToken(request, env, body) {
    invariant(!request.headers.has('authorization') && !Object.hasOwn(body, 'client_secret'), 'invalid_client', 'Service clients authenticate with private_key_jwt only.', 401);
    const service = await activeService(env, body.client_id);
    await authenticateAgent(env, { client_id: service.id, token_endpoint_auth_method: 'private_key_jwt', jwks: JSON.parse(service.jwks) }, body, '/token');
    invariant(typeof body.resource === 'string', 'invalid_target', 'Exactly one resource is required.');
    const app = await ownerOf(env, body.resource);
    invariant(app.id === service.app_id && JSON.parse(service.resource_prefixes).some(prefix => underPrefix(body.resource, prefix)), 'invalid_target', 'This service client cannot reach that resource.');
    // Scopes: what was asked for (default: everything allowed), within the service's list and the app's current catalogue.
    const allowed = JSON.parse(service.scopes), catalogue = agentSettings(app).agent_scope_catalogue;
    const asked = body.scope === undefined ? allowed : String(body.scope).split(' ');
    invariant(asked.length && new Set(asked).size === asked.length && asked.every(scope => allowed.includes(scope) && Object.hasOwn(catalogue, scope)), 'invalid_scope', 'Request scopes this service client is allowed.');
    const jkt = await verifyDpop(env, request, `${env.ISSUER}/token`), now = Math.floor(Date.now() / 1000), scope = asked.join(' ');
    const token = await signAgentJwt(env, { iss: env.ISSUER, aud: body.resource, sub: serviceSubject(service.id), client_id: service.id,
        grant_id: serviceSubject(service.id), scope, ...(jkt ? { cnf: { jkt } } : {}), jti: crypto.randomUUID(), iat: now, exp: now + SERVICE_TOKEN_SECONDS });
    await env.DB.prepare('UPDATE service_clients SET last_used=? WHERE id=?').bind(Date.now(), service.id).run();
    return json({ access_token: token, token_type: jkt ? 'DPoP' : 'Bearer', expires_in: SERVICE_TOKEN_SECONDS, scope });
}
