// Workspace events (docs/WORKSPACES.md#events): rows for the outbox, written in the same batch as the change.
// Delivery (signing, posting `workspace_token`, expiry) is registered with the other outboxes in services/.
import { invariant } from '../lib/errors.mjs';
export const WORKSPACE_EVENTS = ['workspace-member-added', 'workspace-member-removed', 'workspace-role-changed',
    'workspace-updated', 'workspace-products-changed', 'workspace-closed'];
// One outbox row per recipient: every shared app in the workspace's realm with a back-channel URI whose product the
// workspace uses. `version` is the workspace version after the change; read it inside the batch so it always matches
// (pass the SQL `(SELECT version FROM workspaces WHERE id=?)` by giving `version: null`). `extraProducts` adds
// recipients, for workspace-products-changed (the products before the change).
export function workspaceEventStatements(env, workspaceId, event, { userId = null, payload = {}, extraProducts = [] } = {}) {
    invariant(WORKSPACE_EVENTS.includes(event), 'event_config', 'Unknown workspace event.', 503);
    const now = Date.now(), extra = extraProducts.map(() => '?').join(',');
    return [env.DB.prepare(`INSERT INTO workspace_event_outbox(id,client_id,workspace_id,user_id,event,payload,version,uri,created)
        SELECT lower(hex(randomblob(16))),c.id,w.id,?,?,json_set(?,'$.workspace_id',w.id,'$.version',w.version),w.version,c.backchannel_uri,?
        FROM workspaces w JOIN clients c ON c.realm_id=w.realm_id
        WHERE w.id=? AND c.workspaces='shared' AND c.backchannel_uri IS NOT NULL AND c.product IS NOT NULL
          AND (c.product IN (SELECT product FROM workspace_products WHERE workspace_id=w.id)${extra ? ` OR c.product IN (${extra})` : ''})`)
        .bind(userId, event, JSON.stringify(payload), now, workspaceId, ...extraProducts)];
}
