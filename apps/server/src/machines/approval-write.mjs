import { msg } from '../i18n/index.mjs';
import { invariant } from '../lib/errors.mjs';
import { activeMachinesSql, machineAdminSql, machineAudit, machineWorkspaceSql, offeredMachineResourcesSql,
    pendingMachinesSql, MACHINE_ACTIVE_MAX, MACHINE_PENDING_MAX } from './workspace-clients.mjs';

export const machineRequestHref = id => `/machine-client?request_id=${id}`;
export const machineExpiry = (app, now) => now + app.agent_max_grant_days * 86400000;
export const unansweredMachine = msg('This request was already answered or has expired.');

export async function answerMachineRequest(env, row, app, session, approved) {
    const now = Date.now(), user = session.user_id;
    const id = approved ? 'ws-' + Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => byte.toString(16).padStart(2, '0')).join('') : null;
    // A changed policy requires a fresh review. No prior read can substitute for the checks in the claim.
    const policy = `EXISTS(SELECT 1 FROM clients c WHERE c.id=r.app_id AND c.realm_id=r.realm_id
        AND c.mfa=? AND c.agent_consent_mfa=? AND c.mfa_trusted_device_days IS ?
        AND c.agent_max_grant_days=? AND c.agent_scope_catalogue=? AND c.agent_resource_prefixes=?
        AND ${offeredMachineResourcesSql('r', 'r.resources', 'c.agent_workspace_resources')})`;
    const cap = `${pendingMachinesSql('r', '?')} <= ? AND ${activeMachinesSql('r', '?')} < ?`;
    const claim = env.DB.prepare(`UPDATE machine_client_requests AS r SET status=?,decided_by=?,decided_at=?,service_client_id=?
        WHERE r.id=? AND r.realm_id=? AND r.status='pending' AND r.expires_at>?
        AND ${machineWorkspaceSql('r', { agent: true })} AND ${machineAdminSql('r', '?')}
        AND EXISTS(SELECT 1 FROM sessions s WHERE s.hash=? AND s.user_id=? AND s.expires_at>?)
        AND ${policy} ${approved ? 'AND ' + cap : ''}`)
        .bind(approved ? 'approved' : 'denied', user, now, id, row.id, row.realm_id, now, user, session.hash, user, now,
            app.mfa, app.agent_consent_mfa, app.mfa_trusted_device_days, app.agent_max_grant_days, app.agent_scope_catalogue,
            app.agent_resource_prefixes, ...(approved ? [now, MACHINE_PENDING_MAX, now, MACHINE_ACTIVE_MAX] : []));
    // The insert is conditional on this batch's claim. If insertion fails, D1 rolls back the claim and audit.
    const insert = approved ? [env.DB.prepare(`INSERT INTO service_clients
        (id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,status,source,workspace_id,accountable_user_id,expires_at,created,updated)
        SELECT r.service_client_id,r.realm_id,r.app_id,r.name,u.email,r.jwks,r.scopes,r.resources,'active','workspace',
            r.workspace_id,r.decided_by,?,?,? FROM machine_client_requests r JOIN users u ON u.id=r.decided_by
        WHERE r.id=? AND r.realm_id=? AND changes()=1`).bind(machineExpiry(app, now), now, now, row.id, row.realm_id)] : [];
    const detail = { request_id: row.id, workspace_id: row.workspace_id, app_id: row.app_id, ...(approved ? { client_id: id } : {}) };
    const [claimed, effect] = await env.DB.batch([claim, ...insert,
        machineAudit(env, approved ? 'machine_client_approved' : 'machine_client_denied', user, row.id, detail, now)]);
    invariant(claimed.meta.changes === 1 && (!approved || effect.meta.changes === 1), 'invalid_request', unansweredMachine);
}
