import { realmId } from '../realms/realm.mjs';
import { queueRevocation, revocationStatements } from './revocation.mjs';
import { scopedWorkspaceLiveSql } from './workspace-choice.mjs';

export function workspaceEndRevocation(env, grantId, userId, workspaceId, now) {
    return revocationStatements(env, grantId, userId, 'workspace_access_ended', now, null, {
        sql: `agent_grants.workspace_id=? AND agent_grants.expires_at>?
            AND EXISTS(SELECT 1 FROM clients owner WHERE owner.id=agent_grants.app_id AND owner.realm_id=?
                AND NOT (${scopedWorkspaceLiveSql('agent_grants', 'owner')}))`,
        args: [workspaceId, now, realmId(env)]
    });
}

export async function revokeEndedWorkspaceGrant(env, grantId, userId, workspaceId, now) {
    const { statements, eventId } = workspaceEndRevocation(env, grantId, userId, workspaceId, now);
    const result = await env.DB.batch(statements);
    if (result.at(-1).meta.changes === 1) queueRevocation(env, env.CTX, eventId);
}
