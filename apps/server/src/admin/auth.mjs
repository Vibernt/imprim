import { getSession, requireCsrf } from '../auth/session.mjs';
import { adminRole } from '../services/admission.mjs';
import { realmId } from '../realms/realm.mjs';
import { confirmedFactors, ADMIN_MFA_MS } from '../auth/mfa.mjs';
import { invariant } from '../lib/errors.mjs';
export async function adminSession(request, env) {
    const session = await getSession(request, env);
    const role = session ? await adminRole(env, session.email) : null;
    invariant(session && session.method === 'email' && session.email_verified === 1 &&
        role && session.admin_until > Date.now(), 'admin_required',
    'Sign in at /login with an administrator magic link. Admin access lasts one hour.', 403);
    // Administrators always use a second factor, verified within the hour.
    invariant((await confirmedFactors(env, session.user_id)).length, 'mfa_enrolment_required', 'Administrators need a second factor: add one at /account/mfa.', 403);
    invariant(session.mfa_at && session.mfa_at > Date.now() - ADMIN_MFA_MS, 'mfa_required', 'Enter your second-factor code at /mfa?next=/admin.', 403);
    return { ...session, role };
}
// Platform admins manage realms and signing keys; realm admins manage their realm's clients, users and audit.
export function requirePlatform(session) {
    invariant(session.role === 'platform', 'admin_required', 'Platform administrators only.', 403);
}
export async function adminMutation(request, env, session, body, destructive = false) {
    await requireCsrf(request, env, session, body.csrf);
    invariant(!destructive || session.auth_time * 1000 > Date.now() - 600000, 'reauth_required',
        'Sign in again at /login before this action (ten-minute authentication required).', 403);
}
export function auditStatement(env, actor, event, target, detail = {}) {
    return env.DB.prepare('INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES(?,?,?,?,?,?)')
        .bind(event, actor, target, JSON.stringify(detail), Date.now(), env.REALM?.id ?? null);
}
// Every admin write batch rechecks the authenticating session, including after key generation.
export function mutationEnvironment(env, session, destructive) {
    return { ...env, DB: {
        // The binding itself, so per-isolate memos (JWKS, realms) forgotten during an admin write are the real ones.
        raw: env.DB.raw ?? env.DB,
        prepare: sql => env.DB.prepare(sql),
        async batch(statements) {
            const now = Date.now();
            const guard = env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT CASE WHEN EXISTS(
                SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.user_id=?
                AND s.method='email' AND s.admin_until>? AND s.expires_at>? AND s.auth_time>=? AND s.mfa_at>?
                AND u.status='active' AND u.merged_into IS NULL AND u.realm_id=?
                AND EXISTS(SELECT 1 FROM admins a WHERE a.realm_id=u.realm_id AND a.email=u.email AND (a.role='platform' OR ?=0))) THEN 1 ELSE 0 END`)
                .bind(session.hash, session.user_id, now, now, destructive ? Math.floor((now - 600000) / 1000) + 1 : 0, now - ADMIN_MFA_MS, realmId(env), session.role === 'platform' ? 1 : 0);
            try { return (await env.DB.batch([guard, ...statements])).slice(1); }
            catch (error) {
                if (String(error.message).includes('admin_assertions')) invariant(false, 'conflict', 'Authorization or account changed; reload and reauthenticate.', 409);
                throw error;
            }
        }
    } };
}
