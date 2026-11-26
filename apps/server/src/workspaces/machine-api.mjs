import { catalogueHasScope } from '../agents/policy.mjs';
import { agentSettings } from '../agents/settings.mjs';
import { resourceUrl } from '../agents/uris.mjs';
import { invariant } from '../lib/errors.mjs';
import { json } from '../lib/http.mjs';
import { serviceKeys } from '../machines/service-keys.mjs';
import { MACHINE_ACTIVE_MAX, MACHINE_PENDING_MAX, MACHINE_REQUEST_MS, activeMachinesSql, machineAdminSql,
    machineAudit, machineWorkspaceSql, offeredMachineResourcesSql, pendingMachinesSql, workspaceMachineLiveSql,
    workspaceMachineView } from '../machines/workspace-clients.mjs';
import { realmId } from '../realms/realm.mjs';
import { liveActorSession, verifyActor } from './actor.mjs';
import { getWorkspace } from './model.mjs';

export const machineApiPath = /^\/v1\/workspaces\/([A-Za-z0-9_-]{1,64})\/machine-clients(?:\/(?:requests\/([0-9a-f]{32})|(ws-[0-9a-f]{20})))?$/;
const allUnique = items => Array.isArray(items) && items.length > 0 && new Set(items).size === items.length &&
    items.every(item => typeof item === 'string');

async function requestMachine(env, client, workspace, { name, jwks, scopes, resources }) {
    invariant(workspace.status === 'active', 'not_found', 'Workspace not found.', 404);
    invariant(client.agent_access === 'on', 'access_denied', 'Agent access is disabled.', 403);
    invariant(typeof name === 'string' && name.trim() && !/\p{Cc}/u.test(name) && [...name.trim()].length <= 100,
        'invalid_request', 'Enter a name of 1 to 100 characters without control characters.');
    const keys = serviceKeys(jwks), settings = agentSettings(client);
    invariant(allUnique(scopes) && scopes.every(scope => catalogueHasScope(settings, scope)),
        'invalid_request', 'scopes must come from the app\'s scope catalogue.');
    invariant(allUnique(resources) && resources.length <= 5, 'invalid_request', 'Choose 1 to 5 distinct resources.');
    resources.forEach(resource => resourceUrl(resource));

    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    const realm = realmId(env), workspaceId = workspace.workspace_id, now = Date.now(), expiresAt = now + MACHINE_REQUEST_MS;
    const eligible = machineWorkspaceSql('r', { agent: true });
    const offered = offeredMachineResourcesSql('r', 'r.resources', '(SELECT agent_workspace_resources FROM clients WHERE id=r.app_id)');
    const knownScopes = `NOT EXISTS(SELECT 1 FROM json_each(r.scopes) wanted WHERE NOT EXISTS(
        SELECT 1 FROM clients c,json_each(c.agent_scope_catalogue) scope WHERE c.id=r.app_id AND scope.key=wanted.value))`;
    const belowCap = `${pendingMachinesSql('r', '?')} < ? AND ${activeMachinesSql('r', '?')} < ?`;
    const args = [realm, client.id, workspaceId, JSON.stringify(scopes), JSON.stringify(resources)];
    const cte = 'WITH r(realm_id,app_id,workspace_id,scopes,resources) AS (VALUES(?,?,?,?,?))';
    const capArgs = [now, MACHINE_PENDING_MAX, now, MACHINE_ACTIVE_MAX];
    const [insert, , checks] = await env.DB.batch([
        env.DB.prepare(`${cte} INSERT INTO machine_client_requests
            (id,realm_id,app_id,workspace_id,name,jwks,scopes,resources,status,created,expires_at)
            SELECT ?,r.realm_id,r.app_id,r.workspace_id,?,?,r.scopes,r.resources,'pending',?,? FROM r
            WHERE ${eligible} AND ${offered} AND ${knownScopes} AND ${belowCap}`)
            .bind(...args, id, name.trim(), JSON.stringify(keys), now, expiresAt, ...capArgs),
        machineAudit(env, 'machine_client_requested', client.id, id,
            { request_id: id, workspace_id: workspaceId, app_id: client.id }, now),
        env.DB.prepare(`${cte} SELECT (${eligible}) AS eligible,(${offered}) AS offered,(${knownScopes}) AS known_scopes FROM r`).bind(...args)
    ]);
    if (insert.meta.changes !== 1) {
        const { eligible, offered, known_scopes: known } = checks.results[0];
        invariant(eligible, 'access_denied', 'Workspace or app policy changed.', 403);
        invariant(offered, 'invalid_target', 'Choose resources registered to this workspace or configured for workspace choice.');
        invariant(known, 'invalid_request', 'scopes must come from the app\'s scope catalogue.');
        invariant(false, 'limit_reached', 'The workspace has reached its machine client limit.', 409);
    }
    return json({ request_id: id, approval_url: `${env.ISSUER}/machine-client?request_id=${id}`, expires_at: expiresAt }, 201);
}

async function requestStatus(env, client, workspaceId, id) {
    const row = await env.DB.prepare(`SELECT r.status,r.expires_at,r.service_client_id FROM machine_client_requests r
        WHERE r.id=? AND r.realm_id=? AND r.app_id=? AND r.workspace_id=? AND ${machineWorkspaceSql('r', { active: false })}`).bind(id, realmId(env), client.id, workspaceId).first();
    invariant(row, 'not_found', 'Machine client request not found.', 404);
    return json({ request_id: id, status: row.status === 'pending' && row.expires_at <= Date.now() ? 'expired' : row.status,
        ...(row.service_client_id ? { service_client_id: row.service_client_id } : {}), expires_at: row.expires_at });
}

async function listMachines(env, client, workspaceId) {
    const now = Date.now();
    const { results } = await env.DB.prepare(`SELECT s.*,(${workspaceMachineLiveSql('s', '?')}) AS live
        FROM service_clients s WHERE s.realm_id=? AND s.app_id=? AND s.workspace_id=? AND s.source='workspace'
        AND ${machineWorkspaceSql('s', { active: false })} ORDER BY s.created DESC,s.id`).bind(now, realmId(env), client.id, workspaceId).all();
    return json({ machine_clients: results.map(row => ({ ...workspaceMachineView(row, now), accountable_sub: row.accountable_user_id })) });
}

async function disableMachine(env, client, workspaceId, id, { actor_token: actorToken }) {
    const actor = await verifyActor(env, client, actorToken), now = Date.now(), realm = realmId(env);
    const match = "s.id=? AND s.realm_id=? AND s.app_id=? AND s.workspace_id=? AND s.source='workspace'";
    const allowed = `(s.accountable_user_id=? OR ${machineAdminSql('s', '?')})
        AND ${machineWorkspaceSql('s', { active: false })}
        AND EXISTS(SELECT 1 ${liveActorSession})`;
    const matchArgs = [id, realm, client.id, workspaceId];
    const actorArgs = [actor.user.id, actor.user.id, actor.session.sid, actor.user.id, now, realm];
    const [, , access] = await env.DB.batch([
        env.DB.prepare(`UPDATE service_clients AS s SET status='disabled',updated=?
            WHERE ${match} AND ${allowed} AND s.status='active'`).bind(now, ...matchArgs, ...actorArgs),
        machineAudit(env, 'machine_client_disabled', actor.user.id, id, { client_id: id, workspace_id: workspaceId, app_id: client.id }, now),
        env.DB.prepare(`SELECT (${allowed}) AS allowed FROM service_clients s WHERE ${match}`).bind(...actorArgs, ...matchArgs)
    ]);
    invariant(access.results.length === 1, 'not_found', 'Machine client not found.', 404);
    invariant(access.results[0].allowed, 'access_denied', 'Only a workspace owner, admin or the accountable person can disable this machine.', 403);
    return json({ client_id: id, disabled: true });
}

export async function workspaceMachineApi(request, env, client, match, body) {
    const [, workspaceId, requestId, clientId] = match;
    const workspace = await getWorkspace(env, client, workspaceId);
    const { method } = request;
    if (method === 'GET' && requestId) return requestStatus(env, client, workspaceId, requestId);
    if (method === 'DELETE' && clientId) return disableMachine(env, client, workspaceId, clientId, body);
    if (method === 'GET' && !requestId && !clientId) return listMachines(env, client, workspaceId);
    if (method === 'POST' && !requestId && !clientId) return requestMachine(env, client, workspace, body);
    invariant(false, 'not_found', 'Endpoint not found.', 404);
}
