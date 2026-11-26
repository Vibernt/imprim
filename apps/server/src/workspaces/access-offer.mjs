import { realmId } from '../realms/realm.mjs';
import { admissionGuard } from '../services/admission.mjs';
import { workspaceClientSql } from './access.mjs';
import { liveActorSession } from './actor.mjs';
import { usingProduct } from './queries.mjs';

const eligibleWorkspace = `FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
    WHERE w.realm_id=? AND w.kind='team' AND w.status='active' AND m.user_id=? AND NOT ${usingProduct}`;

export const accessWorkspaces = (env, client, userId) => env.DB.prepare(`SELECT w.name,m.role ${eligibleWorkspace}
    ORDER BY w.name,w.id LIMIT 6`).bind(realmId(env), userId, client.product);

export function workspaceAccessGuard(env, { row, client }, session, now) {
    const realm = realmId(env), admission = admissionGuard('s.user_id', client.id);
    return {
        sql: `id=? AND browser_hash=? AND expires_at>? AND client_id=? AND agent_client_id IS NULL AND prompt IS NOT 'none'
            AND workspace_access IS ? AND workspace_join IS ?
            AND EXISTS (SELECT 1 FROM clients c WHERE c.id=? AND c.realm_id=? AND c.product=?
                AND ${workspaceClientSql('c')} AND c.sign_in_methods=? AND c.google_hosted_domains=?
                AND ? IN (SELECT value FROM json_each(c.redirect_uris)))
            AND EXISTS (SELECT 1 ${eligibleWorkspace})
            AND EXISTS (SELECT 1 ${liveActorSession} AND s.hash=? AND NOT ${admission.sql})`,
        args: [row.id, row.browser_hash, now, client.id, row.workspace_access, row.workspace_join,
            client.id, realm, client.product, client.sign_in_methods, client.google_hosted_domains, row.redirect_uri,
            realm, session.user_id, client.product, session.sid, session.user_id, now, realm, session.hash, ...admission.args]
    };
}

export async function offerWorkspaceAccess(env, pending, session) {
    const { row, client } = pending;
    if (row.agent_client_id || row.prompt === 'none' || !client.product) return false;
    const state = JSON.stringify({ user_id: session.user_id, product: client.product });
    if (row.workspace_access && row.workspace_access !== state) return false;
    const guard = workspaceAccessGuard(env, pending, session, Date.now());
    const result = await env.DB.prepare(`UPDATE auth_requests SET workspace_access=? WHERE ${guard.sql}`)
        .bind(state, ...guard.args).run();
    return result.meta.changes === 1;
}
