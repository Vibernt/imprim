import { realmId } from '../realms/realm.mjs';
import { workspaceEventStatements } from './events.mjs';

export const sharedClient = client => client?.workspaces === 'shared' && Boolean(client.product);
export const invitationProof = proof => proof === 'mailbox' || proof === 'provider';

// SQL arguments to these helpers are trusted aliases or expressions. Request values are always bound.
export const workspaceClientSql = client => `${client}.workspaces='shared' AND ${client}.product IS NOT NULL
    AND EXISTS(SELECT 1 FROM realms r WHERE r.id=${client}.realm_id AND r.status='active'
        AND json_extract(r.config,'$.workspaces')='on')`;
export async function usesSharedWorkspaces(env, client) {
    return sharedClient(client) && Boolean(await env.DB.prepare(`SELECT 1 FROM clients c
        WHERE c.id=? AND c.realm_id=? AND ${workspaceClientSql('c')}`).bind(client.id, realmId(env)).first());
}
export const reachesProductSql = (realm, product, user, extra = '1') => `EXISTS(
    SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
    JOIN workspace_products p ON p.workspace_id=w.id
    WHERE m.user_id=${user} AND w.realm_id=${realm} AND w.status='active' AND p.product=${product} AND ${extra})`;

const openInvitation = `i.email=? AND i.expires_at>? AND i.accepted_at IS NULL AND i.revoked_at IS NULL`;
const invitationProduct = `EXISTS(SELECT 1 FROM workspaces w JOIN workspace_products p ON p.workspace_id=w.id
    WHERE w.id=i.workspace_id AND w.realm_id=c.realm_id AND w.status='active' AND w.kind='team' AND p.product=c.product)`;

export async function workspaceAdmits(env, client, userId, email, proof) {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM clients c WHERE c.id=? AND c.realm_id=? AND ${workspaceClientSql('c')}
        AND (${reachesProductSql('c.realm_id', 'c.product', '?')} OR (?=1 AND EXISTS(
            SELECT 1 FROM workspace_invitations i WHERE ${openInvitation} AND ${invitationProduct})))`)
        .bind(client.id, realmId(env), userId, Number(invitationProof(proof)), email, Date.now()).first());
}

const hasMember = `EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=i.workspace_id AND m.user_id=?)`;
const clientForInvitation = `EXISTS(SELECT 1 FROM clients c WHERE c.id=? AND c.realm_id=?
    AND ${workspaceClientSql('c')} AND ${invitationProduct})`;

export async function invitationStatements(env, client, session, proof) {
    if (!invitationProof(proof)) return [];
    const realm = realmId(env);
    const { results } = await env.DB.prepare(`SELECT i.id, i.workspace_id, i.role, ${hasMember} AS member
        FROM workspace_invitations i WHERE ${openInvitation} AND ${clientForInvitation} ORDER BY i.id`)
        .bind(session.user_id, session.email, Date.now(), client.id, realm).all();
    const now = Date.now();
    return results.flatMap(invitation => acceptInvitation(env, client, session, invitation, now, realm));
}

function acceptInvitation(env, client, session, invitation, now, realm) {
    const { id, workspace_id: workspaceId, role, member } = invitation, userId = session.user_id;
    // The event helper emits from the current workspace state. Abort the whole batch before it if a claim lost a race.
    const requireChange = () => env.DB.prepare('INSERT INTO admin_assertions(ok) VALUES(changes()=1)');
    const claim = env.DB.prepare(`UPDATE workspace_invitations AS i SET accepted_at=?,accepted_by=?
        WHERE i.id=? AND i.workspace_id=? AND i.role=? AND ${openInvitation} AND ${clientForInvitation} AND (${hasMember})=?
          AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.realm_id=? AND u.email=i.email
            AND u.status='active' AND u.merged_into IS NULL)`)
        .bind(now, userId, id, workspaceId, role, session.email, now, client.id, realm, userId, member, userId, realm);
    const event = member ? 'workspace-invitation-accepted' : 'workspace-member-added';
    const audit = env.DB.prepare('INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES(?,?,?,?,?,?)')
        .bind(event, userId, workspaceId, JSON.stringify({ workspace_id: workspaceId, invitation_id: id, role }), now, realm);
    if (member) return [claim, requireChange(), audit];
    return [
        claim,
        env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created,updated)
            SELECT ?,?,?,?,? WHERE changes()=1`).bind(workspaceId, userId, role, now, now),
        env.DB.prepare('UPDATE workspaces SET version=version+1 WHERE id=? AND changes()=1').bind(workspaceId),
        requireChange(),
        audit,
        ...workspaceEventStatements(env, workspaceId, event, { userId, payload: { role } })
    ];
}
