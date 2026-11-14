import { invariant } from '../lib/errors.mjs';
import { endAccess } from '../services/access.mjs';
import { auditStatement } from './auth.mjs';
import { realmId } from '../realms/realm.mjs';
import { logoutStatements } from '../oidc/backchannel.mjs';
import { notify } from '../services/notify.mjs';
import { userEventStatements } from '../services/user-events.mjs';
// An admin acts only on people of equal or lower role: a realm admin cannot block, delete, merge or reset the
// second factor of a platform admin.
const RANK = { realm: 1, platform: 2 };
async function requireRank(env, actor, targetEmail) {
    const roles = await env.DB.prepare('SELECT a.email,a.role FROM admins a WHERE a.realm_id=? AND (a.email=(SELECT email FROM users WHERE id=?) OR a.email=?)').bind(realmId(env), actor, targetEmail).all();
    const actorEmail = (await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(actor).first())?.email?.toLowerCase();
    const rank = email => RANK[roles.results.find(r => r.email.toLowerCase() === email?.toLowerCase())?.role] ?? 0;
    invariant(rank(actorEmail) >= rank(targetEmail), 'access_denied', 'You cannot change an administrator with a higher role.', 403);
}
export async function changeUser(env, actor, id, action, survivor, confirmSourceEmail) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE id=? AND realm_id=?').bind(id, realmId(env)).first();
    invariant(user && !user.merged_into, 'invalid_request', 'User unavailable.');
    invariant(id !== actor, 'invalid_request', 'Administrators cannot change their own status or merge themselves.');
    await requireRank(env, actor, user.email);
    invariant(['block','unblock','delete','merge'].includes(action), 'invalid_request', 'Unknown user action.');
    if (action === 'unblock') {
        invariant(user.status === 'blocked', 'invalid_request', 'Only a blocked user can be unblocked.');
        const result = await env.DB.batch([
            env.DB.prepare("UPDATE users SET status='active' WHERE id=? AND status='blocked' AND merged_into IS NULL RETURNING id").bind(id),
            env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id) SELECT 'admin_unblock',?,?,?,?,? WHERE changes()=1`)
                .bind(actor, id, '{}', Date.now(), env.REALM?.id ?? null),
            // Only if this unblock won: a racing delete leaves the person deleted and no event goes out.
            ...userEventStatements(env, id, 'user-unblocked', {}, { sql: "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')", args: [id] })
        ]);
        invariant(result[0].results.length === 1, 'conflict', 'User changed; reload.', 409);
        return { id, status: 'active' };
    }
    invariant(user.status !== 'deleted', 'invalid_request', 'Deleted users cannot be changed.');
    const statements = [];
    if (action === 'merge') {
        invariant(typeof confirmSourceEmail === 'string' && confirmSourceEmail === user.email, 'invalid_request', 'Retype the source email to confirm deletion into the survivor.');
        invariant(typeof survivor === 'string' && survivor !== id && survivor !== actor, 'invalid_request', 'Choose a different surviving user.');
        const target = await env.DB.prepare("SELECT id FROM users WHERE id=? AND realm_id=? AND status='active' AND merged_into IS NULL").bind(survivor, realmId(env)).first();
        invariant(target, 'invalid_request', 'Surviving user must be active.');
        const conflict = await env.DB.prepare(`SELECT 1 FROM user_identities a JOIN user_identities b ON a.provider=b.provider
            WHERE a.user_id=? AND b.user_id=?`).bind(id, survivor).first();
        invariant(!conflict, 'merge_conflict', 'Both users have an identity from the same provider.', 409);
        // Atomic assertions protect against concurrent provider linking, merges, or status changes.
        statements.push(env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT CASE WHEN
            EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND merged_into IS NULL)
            AND NOT EXISTS(SELECT 1 FROM user_identities a JOIN user_identities b ON a.provider=b.provider WHERE a.user_id=? AND b.user_id=?)
            THEN 1 ELSE 0 END`).bind(survivor, id, survivor));
    }
    statements.push(env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT CASE WHEN
        EXISTS(SELECT 1 FROM users WHERE id=? AND status=? AND email=? AND merged_into IS NULL) THEN 1 ELSE 0 END`).bind(id, user.status, user.email));
    statements.push(...userEventStatements(env, id, action === 'block' ? 'user-blocked' : action === 'merge' ? 'user-merged' : 'user-deleted', action === 'merge' ? { into: survivor } : {}));
    statements.push(...endAccess(env, id));
    if (action === 'merge') {
        // Survivor also reauthenticates: no session/grant silently gains a newly linked identity.
        statements.push(...endAccess(env, survivor));
        statements.push(env.DB.prepare('UPDATE user_identities SET user_id=? WHERE user_id=?').bind(survivor, id),
            env.DB.prepare('INSERT OR IGNORE INTO client_admissions(user_id,client_id,created) SELECT ?,client_id,created FROM client_admissions WHERE user_id=?').bind(survivor, id));
    }
    const status = action === 'block' ? 'blocked' : 'deleted';
    statements.push(env.DB.prepare('UPDATE users SET status=?,merged_into=? WHERE id=?').bind(status, action === 'merge' ? survivor : null, id),
        auditStatement(env, actor, `admin_${action}`, id, action === 'merge' ? { surviving_id: survivor } : {}));
    try { await env.DB.batch(statements); }
    catch (error) {
        if (String(error.message).includes('admin_assertions')) invariant(false, 'conflict', 'User changed; reload.', 409);
        throw error;
    }
    return { id, status, ...(action === 'merge' ? { merged_into: survivor } : {}) };
}
export async function users(env, query) {
    const search = (query.get('q') || '').slice(0, 254), cursor = query.get('before') || '\uffff';
    return (await env.DB.prepare(`SELECT id,email,status,merged_into,created FROM users WHERE realm_id=? AND
        (instr(lower(email),lower(?))>0 OR id=?) AND id<? ORDER BY id DESC LIMIT 51`).bind(realmId(env), search, search, cursor).all()).results;
}
export async function userDetail(env, id) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE id=? AND realm_id=?').bind(id, realmId(env)).first();
    invariant(user, 'not_found', 'User not found.', 404);
    const [identities, sessions, grants] = await Promise.all([
        env.DB.prepare('SELECT provider,provider_id,login,created FROM user_identities WHERE user_id=?').bind(id).all(),
        env.DB.prepare('SELECT sid,method,auth_time,expires_at FROM sessions WHERE user_id=? ORDER BY auth_time DESC LIMIT 100').bind(id).all(),
        env.DB.prepare('SELECT id,client_id,app_id,resource,scope,created,last_used,expires_at,revoked_at FROM agent_grants WHERE user_id=? ORDER BY created DESC LIMIT 100').bind(id).all()
    ]);
    return { ...user, identities: identities.results, sessions: sessions.results, grants: grants.results };
}
// Admin MFA reset (a person lost their authenticator): factors, recovery codes and remembered browsers go, identity
// sessions end (apps by back-channel), and the person enrols again at their next sign-in. A reason is required and
// recorded; the person is told by email. Runs inside mutationEnvironment, so it needs a fresh admin second factor.
export async function resetMfa(env, actor, id, reason) {
    invariant(typeof reason === 'string' && reason.trim().length >= 5 && reason.length <= 500, 'invalid_request', 'Give a reason (5 to 500 characters); it goes in the audit log.');
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=? AND realm_id=? AND status='active' AND merged_into IS NULL").bind(id, realmId(env)).first();
    invariant(user, 'not_found', 'User not found.', 404);
    invariant(id !== actor, 'invalid_request', 'Administrators cannot reset their own second factor.');
    await requireRank(env, actor, user.email);
    await env.DB.batch([
        env.DB.prepare('DELETE FROM mfa_factors WHERE user_id=?').bind(id), env.DB.prepare('DELETE FROM recovery_codes WHERE user_id=?').bind(id),
        env.DB.prepare('DELETE FROM webauthn_credentials WHERE user_id=?').bind(id),
        env.DB.prepare('DELETE FROM trusted_devices WHERE user_id=?').bind(id),
        ...logoutStatements(env, id), env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
        ...userEventStatements(env, id, 'mfa-reset'),
        auditStatement(env, actor, 'admin_mfa_reset', id, { reason: reason.trim() })]);
    notify(env, env.CTX, user.email, 'your two-factor authentication was reset', `An administrator reset two-factor authentication on your account (reason: ${reason.trim()}). You were signed out and will set it up again at your next sign-in.`);
    return { id, mfa_reset: true };
}
