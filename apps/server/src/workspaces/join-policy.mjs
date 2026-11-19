import { realmId } from '../realms/realm.mjs';
import { sharedClient, usesSharedWorkspaces, workspaceClientSql } from './access.mjs';
import { joinableTeamWorkspaces } from './queries.mjs';

const hostedLimit = 20;
const interactiveJoin = ({ row, client }) => row.prompt !== 'none' && row.agent_client_id === null &&
    client.join_workspaces === 'on' && sharedClient(client);

const liveJoinClient = `EXISTS(SELECT 1 FROM clients c WHERE c.id=? AND c.realm_id=? AND c.product=?
    AND c.join_workspaces='on' AND ${workspaceClientSql('c')}
    AND c.sign_in_methods=? AND c.google_hosted_domains=?
    AND ? IN (SELECT value FROM json_each(c.redirect_uris)))`;
const clientArgs = (env, { row, client }) => [
    client.id, realmId(env), client.product, client.sign_in_methods, client.google_hosted_domains, row.redirect_uri
];

export async function liveWorkspaceJoin(env, pending) {
    return Boolean(interactiveJoin(pending) && await usesSharedWorkspaces(env, pending.client));
}

// Primary sign-in may establish an identity session for an eligible owner. Admission is still decided by
// completeAuthorization, which is the only place that can offer the hosted step.
export async function canSignInForWorkspaceJoin(env, pending, { userId, email } = {}) {
    if (!pending || !await liveWorkspaceJoin(env, pending)) return false;
    const realm = realmId(env);
    if (!userId) {
        const user = await env.DB.prepare(`SELECT id FROM users WHERE realm_id=? AND email=?
            AND status='active' AND merged_into IS NULL`).bind(realm, email).first();
        if (!user) return false;
        userId = user.id;
    }
    const state = JSON.parse(pending.row.workspace_join);
    if (state && (state.user_id !== userId || state.product !== pending.client.product)) return false;
    return (await joinableTeamWorkspaces(env, realm, userId, pending.client.product, 1, state?.workspace_ids)).length > 0;
}

export async function offerWorkspaceJoin(env, pending, userId) {
    if (!await liveWorkspaceJoin(env, pending)) return false;
    const { row, client } = pending;
    const existing = JSON.parse(row.workspace_join);
    if (existing && (existing.user_id !== userId || existing.product !== client.product)) return false;
    const realm = realmId(env);
    const workspaces = await joinableTeamWorkspaces(env, realm, userId, client.product, hostedLimit, existing?.workspace_ids);
    if (!workspaces.length) return false;
    if (existing) return true;
    const state = JSON.stringify({ user_id: userId, product: client.product, workspace_ids: workspaces.map(w => w.workspace_id) });
    const result = await env.DB.prepare(`UPDATE auth_requests SET workspace_join=?
        WHERE id=? AND browser_hash=? AND expires_at>? AND client_id=? AND workspace_join IS NULL AND ${liveJoinClient}`)
        .bind(state, row.id, row.browser_hash, Date.now(), client.id, ...clientArgs(env, pending)).run();
    return result.meta.changes === 1;
}

export function workspaceJoinRequestGuard(env, { row, client }, now) {
    return {
        sql: `id=? AND browser_hash=? AND expires_at>? AND client_id=? AND workspace_join=? AND ${liveJoinClient}`,
        args: [row.id, row.browser_hash, now, client.id, row.workspace_join, ...clientArgs(env, { row, client })]
    };
}
