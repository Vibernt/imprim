import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { reachesProductSql, workspaceClientSql } from '../workspaces/access.mjs';
import { brandingFor } from '../branding/tokens.mjs';

const choices = `SELECT w.id,w.name,w.kind FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
    JOIN workspace_products p ON p.workspace_id=w.id
    JOIN clients c ON c.realm_id=w.realm_id AND c.product=p.product
    WHERE c.id=? AND c.realm_id=? AND m.user_id=? AND w.status='active' AND ${workspaceClientSql('c')}
    ORDER BY w.name,w.id LIMIT 50`;
const choiceArgs = (env, app, userId) => [app.id, realmId(env), userId];

export async function listWorkspaceChoices(env, app, userId) {
    const { results } = await env.DB.prepare(choices).bind(...choiceArgs(env, app, userId)).all();
    return results;
}

export function requireWorkspaceChoices(env, app, workspaces) {
    if (workspaces.length) return;
    env.SIGN_IN = { app: app.id };
    invariant(false, 'access_denied', 'You are not in any workspace that uses {app}.', 403,
        { app: brandingFor(env, app).name || app.id });
}

export const workspaceChoiceGuard = (env, app, userId, id) => ({
    sql: `EXISTS(SELECT 1 FROM (${choices}) offered WHERE offered.id=?)`,
    args: [...choiceArgs(env, app, userId), id]
});

// SQL aliases are fixed by the callers. A scoped grant always uses its original app's current product.
export const scopedWorkspaceLiveSql = (grant, client) => `${workspaceClientSql(client)}
    AND ${reachesProductSql(`${client}.realm_id`, `${client}.product`, `${grant}.user_id`, `w.id=${grant}.workspace_id`)}`;

// A grant that predates a resource's switch to workspace choice cannot issue unscoped access there.
export const unscopedResourceLiveSql = (grant, client) => `NOT EXISTS(
    SELECT 1 FROM json_each(${client}.agent_workspace_resources) WHERE value=${grant}.resource)`;
