import { invariant } from '../lib/errors.mjs';
import { logoutStatements } from '../oidc/backchannel.mjs';
import { auditStatement } from './auth.mjs';
import { realmId } from '../realms/realm.mjs';
// Session-scoped revocation does not revoke the user's separately approved agent grants.
export async function revokeSession(env, actor, userId, sid) {
    invariant(typeof sid === 'string' && sid.length > 0, 'invalid_request', 'A session id is required.');
    const row = await env.DB.prepare('SELECT s.sid FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=? AND s.sid=? AND u.realm_id=?').bind(userId, sid, realmId(env)).first();
    invariant(row, 'not_found', 'Session not found for this user.', 404);
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT CASE WHEN EXISTS(
            SELECT 1 FROM sessions WHERE user_id=? AND sid=?) THEN 1 ELSE 0 END`).bind(userId, sid),
        ...logoutStatements(env, userId, sid),
        env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND sid=?').bind(userId, sid),
        auditStatement(env, actor, 'admin_revoke_session', userId, { sid })
    ]);
    return { id: userId, sid, revoked: true };
}
