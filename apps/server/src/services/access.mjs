import { logoutStatements } from '../oidc/backchannel.mjs';
import { invariant } from '../lib/errors.mjs';
// Must be in the same batch as the status change. Exchanges fence current user status.
export function endAccess(env, id) {
    const now = Date.now();
    return [
        ...logoutStatements(env, id),
        env.DB.prepare(`INSERT INTO agent_revocation_outbox(id,grant_id,app_id,user_id,resource,uri,created)
            SELECT lower(hex(randomblob(16))),g.id,g.app_id,g.user_id,g.resource,coalesce(c.backchannel_uri,''),?
            FROM agent_grants g JOIN clients c ON c.id=g.app_id
            WHERE g.user_id=? AND g.revoked_at IS NULL`).bind(now, id),
        env.DB.prepare('UPDATE agent_grants SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now, id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
        env.DB.prepare('DELETE FROM magic_links WHERE (realm_id,lower(email))=(SELECT realm_id,lower(email) FROM users WHERE id=?)').bind(id),
        // Retain denied devices so pollers get a useful denial, never an approval after unblock.
        env.DB.prepare(`UPDATE agent_devices SET status='denied' WHERE grant_id IN (SELECT id FROM agent_grants WHERE user_id=?)`).bind(id)
    ];
}
// First mailbox proof for an account a provider created unverified (S4): whoever held that provider identity was
// trusted on a "verified" flag alone. Their links, sessions and agent grants end; the mailbox owner keeps the account.
export function mailboxClaimStatements(env, user, now) {
    return [
        ...endAccess(env, user.id),
        env.DB.prepare('DELETE FROM user_identities WHERE user_id=?').bind(user.id),
        env.DB.prepare('DELETE FROM user_passwords WHERE user_id=?').bind(user.id),
        env.DB.prepare('DELETE FROM webauthn_credentials WHERE user_id=?').bind(user.id),
        env.DB.prepare('UPDATE users SET email_verified=1 WHERE id=?').bind(user.id),
        env.DB.prepare("INSERT INTO audit(event,actor,target,detail,created,realm_id) SELECT 'mailbox_claimed',?,?,'{}',?,realm_id FROM users WHERE id=?").bind(user.id, user.id, now, user.id)
    ];
}

export async function claimMailbox(env, user) {
    if (user.email_verified === 1) return user;
    await env.DB.batch([
        env.DB.prepare('INSERT INTO admin_assertions(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=? AND email_verified=0) THEN 1 ELSE 0 END').bind(user.id),
        ...mailboxClaimStatements(env, user, Date.now())
    ]).catch(error => { invariant(!String(error.message).includes('admin_assertions'), 'conflict', 'Account changed; sign in again.', 409); throw error; });
    return { ...user, email_verified: 1 };
}
