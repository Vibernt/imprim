import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { machineAudit, workspaceMachineLiveSql, workspaceMachineView } from './workspace-clients.mjs';

export async function readAccountMachines(env, session) {
    const now = Date.now();
    const { results } = await env.DB.prepare(`SELECT s.id,s.name,s.scopes,s.resource_prefixes,s.status,s.created,s.expires_at,s.last_used,
        c.branding,c.id AS app_id,w.name AS workspace,(${workspaceMachineLiveSql('s', '?')}) AS live
        FROM service_clients s JOIN clients c ON c.id=s.app_id AND c.realm_id=s.realm_id
        JOIN workspaces w ON w.id=s.workspace_id AND w.realm_id=s.realm_id
        WHERE s.realm_id=? AND s.accountable_user_id=? AND s.source='workspace' ORDER BY s.created DESC,s.id`)
        .bind(now, realmId(env), session.user_id).all();
    return results.map(row => ({ ...workspaceMachineView(row, now), app: JSON.parse(row.branding).name || row.app_id,
        workspace: row.workspace, can_disable: row.status === 'active' }));
}

export async function changeAccountMachine(env, session, { client_id }, renew) {
    const now = Date.now(), realm = realmId(env), user = session.user_id;
    const owned = "s.id=? AND s.realm_id=? AND s.source='workspace' AND s.accountable_user_id=?";
    const id = typeof client_id === 'string' && /^ws-[0-9a-f]{20}$/.test(client_id) ? client_id : null;
    const args = [id, realm, user];
    const change = renew
        ? `expires_at=? + 86400000 * (SELECT c.agent_max_grant_days FROM clients c WHERE c.id=s.app_id),updated=?`
        : "status='disabled',updated=?";
    const eligible = renew ? workspaceMachineLiveSql('s', '?') : "s.status='active'";
    const [update, , match] = await env.DB.batch([
        env.DB.prepare(`UPDATE service_clients AS s SET ${change} WHERE ${owned} AND ${eligible}
            AND EXISTS(SELECT 1 FROM sessions live JOIN users u ON u.id=live.user_id WHERE live.hash=?
                AND live.user_id=s.accountable_user_id AND live.expires_at>? AND u.realm_id=s.realm_id
                AND u.status='active' AND u.merged_into IS NULL)`)
            .bind(...(renew ? [now, now, ...args, now] : [now, ...args]), session.hash, now),
        machineAudit(env, renew ? 'machine_client_renewed' : 'machine_client_disabled', user, id, { client_id: id }, now),
        env.DB.prepare(`SELECT 1 FROM service_clients s WHERE ${owned}`).bind(...args)
    ]);
    invariant(match.results.length === 1, 'not_found', 'Machine client not found.', 404);
    if (renew) invariant(update.meta.changes === 1, 'invalid_request', 'Only an active machine can be renewed.');
}
