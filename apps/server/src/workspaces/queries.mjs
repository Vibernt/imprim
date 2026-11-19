export const productList = `(SELECT json_group_array(product) FROM
    (SELECT product FROM workspace_products WHERE workspace_id=w.id ORDER BY product))`;
export const usingProduct = 'EXISTS(SELECT 1 FROM workspace_products WHERE workspace_id=w.id AND product=?)';
export const withProducts = row => ({ ...row, products: JSON.parse(row.products) });

export async function joinableTeamWorkspaces(env, realm, userId, product, limit, offeredIds = null) {
    const { results } = await env.DB.prepare(`SELECT w.id AS workspace_id,w.name,w.kind,w.created_via,w.version,${productList} AS products
        FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
        WHERE w.realm_id=? AND w.kind='team' AND w.status='active' AND m.user_id=? AND m.role='owner'
          AND NOT ${usingProduct}${offeredIds ? ' AND w.id IN (SELECT value FROM json_each(?))' : ''}
        ORDER BY w.name,w.id LIMIT ?`)
        .bind(realm, userId, product, ...(offeredIds ? [JSON.stringify(offeredIds)] : []), limit).all();
    return results.map(withProducts);
}
