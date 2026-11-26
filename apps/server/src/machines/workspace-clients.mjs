import { realmId } from '../realms/realm.mjs';
import { workspaceClientSql } from '../workspaces/access.mjs';

// All interpolated SQL here is a trusted alias or expression. Request values are bound.
export const machineWorkspaceSql = (row, { active = true, agent = false } = {}) => `EXISTS(
    SELECT 1 FROM workspaces w JOIN clients c ON c.realm_id=w.realm_id
    JOIN workspace_products p ON p.workspace_id=w.id AND p.product=c.product
    WHERE w.id=${row}.workspace_id AND c.id=${row}.app_id AND w.realm_id=${row}.realm_id
    AND ${workspaceClientSql('c')}${active ? " AND w.status='active'" : ''}${agent ? " AND c.agent_access='on'" : ''})`;

export const machineAdminSql = (row, user) => `EXISTS(
    SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=${row}.workspace_id AND m.user_id=${user} AND u.realm_id=${row}.realm_id
    AND m.role IN ('owner','admin') AND u.status='active' AND u.merged_into IS NULL)`;

export const workspaceMachineLiveSql = (row, now) => `${row}.source='workspace' AND ${row}.status='active'
    AND ${row}.expires_at>${now} AND ${machineWorkspaceSql(row)} AND ${machineAdminSql(row, `${row}.accountable_user_id`)}`;

const serviceLiveSql = (row, now) => `${row}.status='active' AND (
    (${row}.source='admin' AND ${row}.workspace_id IS NULL AND ${row}.accountable_user_id IS NULL AND ${row}.expires_at IS NULL)
    OR (${workspaceMachineLiveSql(row, now)}))`;

export function liveService(env, id) {
    return env.DB.prepare(`SELECT s.* FROM service_clients s WHERE s.id=? AND s.realm_id=? AND ${serviceLiveSql('s', '?')}`)
        .bind(id, realmId(env), Date.now()).first();
}

export const MACHINE_REQUEST_MS = 86400000;
export const MACHINE_PENDING_MAX = 10;
export const MACHINE_ACTIVE_MAX = 20;
export const pendingMachinesSql = (row, now) => `(SELECT count(*) FROM machine_client_requests pending
    WHERE pending.workspace_id=${row}.workspace_id AND pending.status='pending' AND pending.expires_at>${now})`;
export const activeMachinesSql = (row, now) => `(SELECT count(*) FROM service_clients active
    WHERE active.workspace_id=${row}.workspace_id AND active.source='workspace'
    AND active.status='active' AND active.expires_at>${now})`;

export const offeredMachineResourcesSql = (row, resources, choices) => `NOT EXISTS(
    SELECT 1 FROM json_each(${resources}) wanted WHERE NOT (
        EXISTS(SELECT 1 FROM workspace_resources wr WHERE wr.resource=wanted.value
            AND wr.workspace_id=${row}.workspace_id AND wr.client_id=${row}.app_id)
        OR EXISTS(SELECT 1 FROM json_each(${choices}) choice WHERE choice.value=wanted.value)))`;

// A resource can be removed or registered to a different workspace after approval.
export function liveWorkspaceMachineResource(env, service, resource) {
    return env.DB.prepare(`SELECT 1 FROM service_clients s JOIN clients c ON c.id=s.app_id AND c.realm_id=s.realm_id
        WHERE s.id=? AND s.realm_id=? AND ${workspaceMachineLiveSql('s', '?')}
        AND EXISTS(SELECT 1 FROM json_each(s.resource_prefixes) stored WHERE stored.value=?)
        AND ${offeredMachineResourcesSql('s', 'json_array(?)', 'c.agent_workspace_resources')}`)
        .bind(service.id, realmId(env), Date.now(), resource, resource).first();
}

export function workspaceMachineView(row, now) {
    return { client_id: row.id, name: row.name, scopes: JSON.parse(row.scopes), resources: JSON.parse(row.resource_prefixes),
        created: row.created, expires_at: row.expires_at, last_used: row.last_used,
        status: row.status === 'disabled' ? 'disabled' : row.expires_at <= now ? 'expired' : row.live ? 'active' : 'disabled' };
}

export function machineAudit(env, event, actor, target, detail, now) {
    return env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
        SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(event, actor, target, JSON.stringify(detail), now, realmId(env));
}
