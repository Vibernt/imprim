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
    const sameWorkspace = `EXISTS(SELECT 1 FROM ending WHERE ending.id=agent_grants.workspace_id
        AND EXISTS(SELECT 1 FROM clients c WHERE c.id=agent_grants.app_id AND c.realm_id=ending.realm_id))`;
    const registered = `workspace_id IS NULL AND resource IN (
        SELECT wr.resource FROM workspace_resources wr JOIN ending ON ending.id=wr.workspace_id)`;
    return [
        ...logoutStatements(env, userId, null, null, lostClients),
        env.DB.prepare(`DELETE FROM client_admissions WHERE user_id=? AND source='workspace' AND client_id IN (${lostClients.sql})`)
            .bind(userId, ...lostClients.args),
        ...endWorkspaceGrants(env, now, `WITH ending AS (${membership})`, [workspaceId, realm, userId],
            `user_id=? AND (${sameWorkspace} OR ${registered})`, [userId])
    ];
}

export function productAccessEndStatements(env, workspaceId, products, now) {
    if (!products.length) return [];
    return endWorkspaceGrants(env, now, '', [], `(workspace_id=? OR (workspace_id IS NULL AND EXISTS(
        SELECT 1 FROM workspace_resources wr WHERE wr.workspace_id=? AND wr.resource=agent_grants.resource AND wr.client_id=agent_grants.app_id)))
        AND app_id IN (
        SELECT c.id FROM clients c JOIN workspace_products p ON p.product=c.product
        WHERE c.realm_id=? AND c.workspaces='shared' AND p.workspace_id=?
        AND p.product IN (SELECT value FROM json_each(?)))`, [workspaceId, workspaceId, realmId(env), workspaceId, JSON.stringify(products)]);
}

function endWorkspaceGrants(env, now, cte, cteArgs, match, args) {
    const live = `revoked_at IS NULL AND expires_at>? AND (${match})`;
    return [
        env.DB.prepare(`${cte} INSERT INTO agent_revocation_outbox(id,grant_id,app_id,user_id,resource,uri,created,reason)
            SELECT lower(hex(randomblob(16))),id,app_id,user_id,resource,coalesce(
                (SELECT c.backchannel_uri FROM clients c WHERE c.id=agent_grants.app_id),''
            ),?,'workspace_access_ended' FROM agent_grants WHERE ${live}`).bind(...cteArgs, now, now, ...args),
        env.DB.prepare(`${cte} UPDATE agent_grants SET revoked_at=? WHERE ${live}`).bind(...cteArgs, now, now, ...args)
    ];
}
