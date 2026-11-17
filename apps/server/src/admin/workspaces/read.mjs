import { invariant } from '../../lib/errors.mjs';
import { realmId } from '../../realms/realm.mjs';

export const root = '/admin/workspaces';
export const newPath = root + '?create=1';
export const workspacePath = id => root + '/' + encodeURIComponent(id);
export const pageSize = 50;
const productList = `(SELECT json_group_array(product) FROM
    (SELECT product FROM workspace_products WHERE workspace_id=w.id ORDER BY product)) AS products`;
const withProducts = row => ({ ...row, products: JSON.parse(row.products) });

export async function listWorkspaces(env, query) {
    const status = query.get('status') ?? '', before = query.get('before') ?? null;
    invariant(['', 'active', 'closed'].includes(status), 'invalid_request', 'Invalid workspace status.');
    invariant(before === null || /^[A-Za-z0-9_-]{1,64}$/.test(before), 'invalid_request', 'Invalid page cursor.');
    const { results } = await env.DB.prepare(`SELECT w.id,w.name,w.kind,w.status,${productList},
        (SELECT count(*) FROM workspace_members WHERE workspace_id=w.id) AS members
        FROM workspaces w WHERE w.realm_id=? AND (?='' OR w.status=?) AND (? IS NULL OR w.id<?)
        ORDER BY w.id DESC LIMIT ?`).bind(realmId(env), status, status, before, before, pageSize + 1).all();
    return results.map(withProducts);
}

export async function workspaceDetail(env, id) {
    const realm = realmId(env);
    const scoped = (sql, ...params) => env.DB.prepare(sql).bind(id, realm, ...params);
    const [workspace, members, invitations, resources, holds, audit] = await env.DB.batch([
        scoped(`SELECT w.id,w.name,w.kind,w.status,${productList} FROM workspaces w WHERE w.id=? AND w.realm_id=?`),
        scoped(`SELECT u.id,u.email,m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
            JOIN users u ON u.id=m.user_id AND u.realm_id=w.realm_id WHERE w.id=? AND w.realm_id=? ORDER BY u.email,u.id`),
        scoped(`SELECT i.id,i.email,i.role,i.expires_at FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id
            WHERE w.id=? AND w.realm_id=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?
            ORDER BY i.created,i.id`, Date.now()),
        scoped(`SELECT r.resource,r.client_id FROM workspace_resources r JOIN workspaces w ON w.id=r.workspace_id
            WHERE w.id=? AND w.realm_id=? ORDER BY r.resource`),
        scoped(`SELECT h.client_id,h.reason FROM workspace_holds h JOIN workspaces w ON w.id=h.workspace_id
            WHERE w.id=? AND w.realm_id=? ORDER BY h.client_id`),
        scoped(`SELECT event,actor,created FROM audit WHERE target=? AND realm_id=?
            AND substr(event,1,10) IN ('workspace-', 'workspace_') ORDER BY id DESC LIMIT 20`)
    ]);
    const row = workspace.results[0];
    invariant(row, 'not_found', 'Workspace not found.', 404);
    return { ...withProducts(row), members: members.results, invitations: invitations.results,
        resources: resources.results, holds: holds.results, audit: audit.results };
}
