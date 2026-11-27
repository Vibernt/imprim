import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { liveAdmissionSql } from '../services/admission.mjs';
import { memberPage } from './member-page.mjs';
import { memberRoleExists, openInvitationRows, realmWorkspacesOn, workspaceMemberPage } from './queries.mjs';

export const accountWorkspacesPath = '/account/workspaces';
export const accountWorkspaceId = /^[A-Za-z0-9_-]{1,64}$/;
export const requireVisibleWorkspace = row => invariant(row, 'not_found', 'Workspace not found.', 404);

const visible = `FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
    WHERE w.realm_id=? AND m.user_id=? AND w.status='active' AND EXISTS(${realmWorkspacesOn})`;

const countMembers = (condition = '') => `(SELECT count(*) FROM workspace_members WHERE workspace_id=w.id ${condition})`;
const displayName = "coalesce(nullif(json_extract(c.branding,'$.name'),''),c.id)";
const products = `(SELECT json_group_array(json_object('product',p.product,'apps',json((
        SELECT json_group_array(json_object('id',app.id,'name',app.name,'initiate_login_uri',app.address))
        FROM (SELECT c.id,${displayName} AS name,
            CASE WHEN c.listed=1 OR (${liveAdmissionSql}) THEN c.initiate_login_uri END AS address
            FROM clients c LEFT JOIN client_admissions a ON a.client_id=c.id AND a.user_id=m.user_id
            WHERE c.realm_id=w.realm_id AND c.product=p.product AND c.workspaces='shared'
            ORDER BY name COLLATE NOCASE,c.id) app
    )))) FROM (SELECT product FROM workspace_products WHERE workspace_id=w.id ORDER BY product) p)`;
const columns = `w.id AS workspace_id,w.name,w.kind,m.role,${countMembers()} AS members,${products} AS products`;
const withApps = row => ({ ...row, products: JSON.parse(row.products) });
const visibilityArgs = (env, sub) => [realmId(env), sub, realmId(env)];

export async function canSeeAccountWorkspaces(env, sub, id) {
    if (id !== undefined && !accountWorkspaceId.test(id)) return false;
    return Boolean(await env.DB.prepare(`SELECT 1 ${visible}${id === undefined ? '' : ' AND w.id=?'} LIMIT 1`)
        .bind(...visibilityArgs(env, sub), ...(id === undefined ? [] : [id])).first());
}

export async function accountWorkspaces(env, sub) {
    const { results } = await env.DB.prepare(`SELECT ${columns} ${visible} ORDER BY w.name COLLATE NOCASE,w.id`)
        .bind(...visibilityArgs(env, sub)).all();
    requireVisibleWorkspace(results.length);
    return results.map(withApps);
}

export async function accountWorkspace(env, sub, id, after) {
    const manage = { sql: memberRoleExists("AND role IN ('owner','admin')"), args: [id, sub] };
    // The role, page and invitations are read together, so a concurrent demotion cannot expose invitations.
    const [record, members, invitations] = await env.DB.batch([
        env.DB.prepare(`SELECT ${columns},w.version,${countMembers("AND role='owner'")} AS owner_count
            ${visible} AND w.id=?`).bind(...visibilityArgs(env, sub), id),
        workspaceMemberPage(env, id, 50, after),
        openInvitationRows(env, id, manage)
    ]);
    requireVisibleWorkspace(record.results[0]);
    const { role, ...workspace } = withApps(record.results[0]);
    return { workspace, role, members: memberPage(members.results, 50),
        ...(role === 'owner' || role === 'admin' ? { invitations: invitations.results } : {}) };
}
