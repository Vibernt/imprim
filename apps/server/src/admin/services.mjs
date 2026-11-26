// Service clients (machine identities), managed by realm admins: one app, a named owner, public keys, scopes from the
// app's catalogue and resource prefixes under the app's own. Secrets never exist: the machine holds its private key.
import { invariant } from '../lib/errors.mjs';
import { serviceKeys } from '../machines/service-keys.mjs';
import { machineAudit } from '../machines/workspace-clients.mjs';
import { agentSettings } from '../agents/settings.mjs';
import { underPrefix, resourceUrl } from '../agents/uris.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { getClient } from '../oidc/clients.mjs';
import { auditStatement } from './auth.mjs';
import { realmId } from '../realms/realm.mjs';
const view = row => ({ ...row, jwks: JSON.parse(row.jwks), scopes: JSON.parse(row.scopes), resource_prefixes: JSON.parse(row.resource_prefixes) });
const serviceDetails = `SELECT s.*,w.name AS workspace_name,u.email AS accountable_email,u.id AS accountable_sub
    FROM service_clients s LEFT JOIN workspaces w ON w.id=s.workspace_id AND w.realm_id=s.realm_id
    LEFT JOIN users u ON u.id=s.accountable_user_id AND u.realm_id=s.realm_id`;
export async function listServices(env) {
    return (await env.DB.prepare(`${serviceDetails} WHERE s.realm_id=? ORDER BY s.id`).bind(realmId(env)).all()).results.map(view);
}

async function disableWorkspaceService(env, actor, row, input) {
    invariant(Object.keys(input).length === 1 && input.status === 'disabled',
        'invalid_request', 'Workspace service clients can only be disabled.');
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare(`UPDATE service_clients SET status='disabled',updated=?
            WHERE id=? AND realm_id=? AND source='workspace' AND status='active'`).bind(now, row.id, realmId(env)),
        machineAudit(env, 'machine_client_disabled', actor, row.id,
            { client_id: row.id, workspace_id: row.workspace_id, app_id: row.app_id }, now)
    ]);
    return { service: view(await env.DB.prepare(`${serviceDetails} WHERE s.id=? AND s.realm_id=?`).bind(row.id, realmId(env)).first()) };
}
async function validate(env, input, old) {
    const value = { ...old, ...input };
    invariant(typeof value.id === 'string' && /^[a-z0-9][a-z0-9-]{2,59}$/.test(value.id), 'invalid_request', 'id: 3-60 lowercase letters, digits or hyphens.');
    invariant(typeof value.name === 'string' && value.name.trim() && value.name.length <= 100, 'invalid_request', 'name: 1-100 characters.');
    value.owner_email = normalizeEmail(value.owner_email);
    const app = await getClient(env, value.app_id);
    const settings = agentSettings(app);
    const jwks = serviceKeys(value.jwks);
    invariant(Array.isArray(value.scopes) && value.scopes.length >= 1 && new Set(value.scopes).size === value.scopes.length &&
        value.scopes.every(scope => Object.hasOwn(settings.agent_scope_catalogue, scope)), 'invalid_request', 'scopes must come from the app\'s scope catalogue.');
    invariant(Array.isArray(value.resource_prefixes) && value.resource_prefixes.length >= 1 && value.resource_prefixes.length <= 20, 'invalid_request', 'resource_prefixes: 1 to 20.');
    for (const prefix of value.resource_prefixes) {
        resourceUrl(prefix, 'prefix');
        invariant(settings.agent_resource_prefixes.some(own => underPrefix(prefix.replace(/\/$/, '') || prefix, own)), 'invalid_request', 'Each resource prefix must be under one of the app\'s own prefixes.');
    }
    invariant(['active', 'disabled'].includes(value.status ?? 'active'), 'invalid_request', 'status is active or disabled.');
    return { id: value.id, app_id: app.id, name: value.name.trim(), owner_email: value.owner_email, jwks: JSON.stringify(jwks), scopes: JSON.stringify(value.scopes),
        resource_prefixes: JSON.stringify(value.resource_prefixes), status: value.status ?? 'active' };
}
export async function saveService(env, actor, id, input) {
    invariant(input && typeof input === 'object', 'invalid_request', 'Body required.');
    const allowed = ['id', 'app_id', 'name', 'owner_email', 'jwks', 'scopes', 'resource_prefixes', 'status'];
    invariant(Object.keys(input).every(key => allowed.includes(key)), 'invalid_request', 'Unknown service client field.');
    const row = id ? await env.DB.prepare('SELECT * FROM service_clients WHERE id=? AND realm_id=?').bind(id, realmId(env)).first() : null;
    invariant(!id || row, 'not_found', 'Service client not found.', 404);
    if (row?.source === 'workspace') return disableWorkspaceService(env, actor, row, input);
    invariant(!id || input.id === undefined || input.id === id, 'invalid_request', 'The id cannot change.');
    const value = await validate(env, input, row ? view(row) : {}), now = Date.now();
    const statement = row
        ? env.DB.prepare("UPDATE service_clients SET app_id=?,name=?,owner_email=?,jwks=?,scopes=?,resource_prefixes=?,status=?,updated=? WHERE id=? AND realm_id=? AND source='admin'")
            .bind(value.app_id, value.name, value.owner_email, value.jwks, value.scopes, value.resource_prefixes, value.status, now, id, realmId(env))
        : env.DB.prepare('INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .bind(value.id, realmId(env), value.app_id, value.name, value.owner_email, value.jwks, value.scopes, value.resource_prefixes, value.status, now, now);
    try { await env.DB.batch([statement, auditStatement(env, actor, row ? 'admin_service_update' : 'admin_service_create', value.id, { fields: Object.keys(input) })]); }
    catch (error) { invariant(!String(error.message).includes('UNIQUE'), 'conflict', 'That service client id is taken.', 409); throw error; }
    return { service: view(await env.DB.prepare('SELECT * FROM service_clients WHERE id=? AND realm_id=?').bind(value.id, realmId(env)).first()) };
}
export async function deleteService(env, actor, id) {
    const row = await env.DB.prepare('SELECT source FROM service_clients WHERE id=? AND realm_id=?').bind(id, realmId(env)).first();
    invariant(row?.source !== 'workspace', 'invalid_request', 'Workspace service clients can only be disabled.');
    const result = await env.DB.batch([
        env.DB.prepare("DELETE FROM service_clients WHERE id=? AND realm_id=? AND source='admin'").bind(id, realmId(env)),
        env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
            SELECT 'admin_service_delete',?,?,'{}',?,? WHERE changes()=1`).bind(actor, id, Date.now(), realmId(env))
    ]);
    invariant(result[0].meta.changes === 1, 'not_found', 'Service client not found.', 404);
    return { id, deleted: true };
}
