export const productList = `(SELECT json_group_array(product) FROM
    (SELECT product FROM workspace_products WHERE workspace_id=w.id ORDER BY product))`;
export const usingProduct = 'EXISTS(SELECT 1 FROM workspace_products WHERE workspace_id=w.id AND product=?)';
export const withProducts = row => ({ ...row, products: JSON.parse(row.products) });
export const realmWorkspacesOn = "SELECT 1 FROM realms WHERE id=? AND status='active' AND json_extract(config,'$.workspaces')='on'";
export const memberRoleExists = (rolesSql = '') => `EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? ${rolesSql})`;

export function workspaceMemberPage(env, id, limit, after) {
    return env.DB.prepare(`SELECT m.user_id AS sub,u.email,m.role,m.created FROM workspace_members m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=? AND (? IS NULL OR (m.created,m.user_id)>(?,?))
        ORDER BY m.created,m.user_id LIMIT ?`).bind(id, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1);
}

export function openInvitationRows(env, id, { sql = '1', args = [] } = {}) {
    return env.DB.prepare(`SELECT id AS invitation_id,email,role,expires_at FROM workspace_invitations
        WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>? AND (${sql})
        ORDER BY created,id`).bind(id, Date.now(), ...args);
}

export async function joinableTeamWorkspaces(env, realm, userId, product, limit, offeredIds = null) {
    const { results } = await env.DB.prepare(`SELECT w.id AS workspace_id,w.name,w.kind,w.created_via,w.version,${productList} AS products
        FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
        WHERE w.realm_id=? AND w.kind='team' AND w.status='active' AND m.user_id=? AND m.role='owner'
          AND NOT ${usingProduct}${offeredIds ? ' AND w.id IN (SELECT value FROM json_each(?))' : ''}
        ORDER BY w.name,w.id LIMIT ?`)
        .bind(realm, userId, product, ...(offeredIds ? [JSON.stringify(offeredIds)] : []), limit).all();
    return results.map(withProducts);
}
