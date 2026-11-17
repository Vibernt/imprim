// Workspace events (docs/WORKSPACES.md#events): rows for the outbox, written in the same batch as the change.
// Delivery (signing, posting `workspace_token`, expiry) is registered with the other outboxes in services/.
import { invariant } from '../lib/errors.mjs';
export const WORKSPACE_EVENTS = ['workspace-member-added', 'workspace-member-removed', 'workspace-role-changed',
    'workspace-updated', 'workspace-products-changed', 'workspace-closed'];
// One outbox row per recipient: every shared app in the workspace's realm with a back-channel URI whose product the
// workspace uses. Read the version inside the batch. For product changes, the caller can capture recipients after
// insertions and before deletions, with removeProducts projecting the final list into the event's payload.
export function workspaceEventStatements(env, workspaceId, event, { userId = null, payload = {}, extraProducts = [], removeProducts = [], writeIf } = {}) {
    invariant(WORKSPACE_EVENTS.includes(event), 'event_config', 'Unknown workspace event.', 503);
    const now = Date.now();
    let eventPayload = 'json_set(?,\'$.workspace_id\',w.id,\'$.version\',w.version)';
    const args = [userId, event, JSON.stringify(payload)];
    if (event === 'workspace-updated') eventPayload = `json_set(${eventPayload},'$.name',w.name)`;
    if (event === 'workspace-products-changed' && !Object.hasOwn(payload, 'products')) {
        eventPayload = `json_set(${eventPayload},'$.products',json((SELECT json_group_array(product) FROM
            (SELECT product FROM workspace_products WHERE workspace_id=w.id
                AND product NOT IN (SELECT value FROM json_each(?)) ORDER BY product))))`;
        args.push(JSON.stringify(removeProducts));
    }
    return [env.DB.prepare(`INSERT INTO workspace_event_outbox(id,client_id,workspace_id,user_id,event,payload,version,uri,created)
        SELECT lower(hex(randomblob(16))),c.id,w.id,?,?,${eventPayload},w.version,c.backchannel_uri,?
        FROM workspaces w JOIN clients c ON c.realm_id=w.realm_id
        WHERE w.id=? AND c.workspaces='shared' AND c.backchannel_uri IS NOT NULL AND c.product IS NOT NULL
          AND (c.product IN (SELECT product FROM workspace_products WHERE workspace_id=w.id)
            OR c.product IN (SELECT value FROM json_each(?)))${writeIf ? ` AND (${writeIf.sql})` : ''}`)
        .bind(...args, now, workspaceId, JSON.stringify(extraProducts), ...(writeIf?.args ?? []))];
}
