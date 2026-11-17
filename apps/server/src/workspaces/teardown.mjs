import { logoutStatements } from '../oidc/backchannel.mjs';
import { realmId } from '../realms/realm.mjs';
import { reachesProductSql } from './access.mjs';

// Ending access that came from a workspace (docs/WORKSPACES.md#signing-in-to-a-shared-app). Statements for the same
// batch that removes the member or closes the workspace. Run them BEFORE the statement that deletes the membership:
// they read workspace_members to tell which products the person still reaches through another workspace.
// accessEndStatements(env, workspaceId, userId) -> D1 statements
export function accessEndStatements(env, workspaceId, userId) {
    const realm = realmId(env), now = Date.now();
    const membership = `SELECT w.id,w.realm_id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
        WHERE w.id=? AND w.realm_id=? AND w.status='active' AND m.user_id=?`;
    const lostClients = {
        sql: `SELECT c.id FROM (${membership}) ending
              JOIN workspace_products ending_product ON ending_product.workspace_id=ending.id
              JOIN clients c ON c.realm_id=ending.realm_id AND c.product=ending_product.product AND c.workspaces='shared'
              WHERE NOT ${reachesProductSql('ending.realm_id', 'ending_product.product', '?', 'w.id<>ending.id')}`,
        args: [workspaceId, realm, userId, userId]
    };
    const liveGrant = `user_id=? AND revoked_at IS NULL AND expires_at>? AND resource IN (
        SELECT wr.resource FROM workspace_resources wr JOIN (${membership}) ending ON ending.id=wr.workspace_id)`;
    const grantArgs = [userId, now, workspaceId, realm, userId];
    return [
        ...logoutStatements(env, userId, null, null, lostClients),
        env.DB.prepare(`DELETE FROM client_admissions WHERE user_id=? AND source='workspace' AND client_id IN (${lostClients.sql})`)
            .bind(userId, ...lostClients.args),
        env.DB.prepare(`INSERT INTO agent_revocation_outbox(id,grant_id,app_id,user_id,resource,uri,created)
            SELECT lower(hex(randomblob(16))),g.id,g.app_id,g.user_id,g.resource,coalesce(
                (SELECT c.backchannel_uri FROM clients c WHERE c.id=g.app_id),''
            ),? FROM agent_grants g WHERE ${liveGrant}`).bind(now, ...grantArgs),
        env.DB.prepare(`UPDATE agent_grants SET revoked_at=? WHERE ${liveGrant}`).bind(now, ...grantArgs)
    ];
}
