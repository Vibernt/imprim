import { requireApiSession } from '../api/json.mjs';
import { getSession, requireCsrf } from '../auth/session.mjs';
import { adminRole } from '../services/admission.mjs';
import { realmId } from '../realms/realm.mjs';
import { confirmedFactors, ADMIN_MFA_MS } from '../auth/mfa.mjs';
import { invariant } from '../lib/errors.mjs';
export const ADMIN_FRESH_MS = 600000;
const SCOPED_SIGN_IN = 'Sign in at /login with an administrator magic link. Admin access lasts one hour.';
// The first rule this session fails before it may use the admin console, as [code, message], or null. The console's
// pages and API enforce it (adminSession); /v1/me reports it, so the navigation shows only what the session can open.
export async function adminBlock(env, session, role, api = false) {
    if (!(session && session.method === 'email' && session.email_verified === 1 && role)) return ['admin_required', SCOPED_SIGN_IN];
    if (!(session.admin_until > Date.now())) return [api ? 'reauth_required' : 'admin_required', SCOPED_SIGN_IN];
    // Administrators always use a second factor, verified within the hour.
    if (!(await confirmedFactors(env, session.user_id)).length)
        return [api ? 'mfa_required' : 'mfa_enrolment_required', 'Administrators need a second factor: add one at /account/mfa.'];
    if (!(session.mfa_at && session.mfa_at > Date.now() - ADMIN_MFA_MS)) return ['mfa_required', 'Enter your second-factor code at /mfa?next=/admin.'];
    return null;
}
export async function adminSession(request, env, api = false) {
    const session = await (api ? requireApiSession(request, env) : getSession(request, env));
    const role = session ? await adminRole(env, session.email) : null;
    const block = await adminBlock(env, session, role, api);
    invariant(!block, block?.[0], block?.[1], 403);
    if (env.SEEN) env.SEEN.role = role;
    return { ...session, role };
}
// Platform admins manage realms and signing keys; realm admins manage their realm's clients, users and audit.
export function requirePlatform(session) {
    invariant(session.role === 'platform', 'admin_required', 'Platform administrators only.', 403);
}
export async function adminMutation(request, env, session, body, destructive = false) {
    await requireCsrf(request, env, session, body.csrf);
    if (destructive) requireAdminFresh(session);
}
export function requireAdminFresh(session) {
    invariant(session.auth_time * 1000 > Date.now() - ADMIN_FRESH_MS, 'reauth_required',
        'Sign in again at /login before this action (ten-minute authentication required).', 403);
}
export function auditStatement(env, actor, event, target, detail = {}) {
    return env.DB.prepare('INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES(?,?,?,?,?,?)')
        .bind(event, actor, target, JSON.stringify(detail), Date.now(), env.REALM?.id ?? null);
}
// The workspace model also uses this predicate in its conditional version claim.
export function adminWriteGuard(env, session, destructive, now) {
    return {
        sql: `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.user_id=?
            AND s.method='email' AND s.admin_until>? AND s.expires_at>? AND s.auth_time>=? AND s.mfa_at>?
            AND u.status='active' AND u.merged_into IS NULL AND u.realm_id=? AND u.email=? AND u.email_verified=1
            AND (EXISTS(SELECT 1 FROM mfa_factors WHERE user_id=u.id AND confirmed=1)
                OR EXISTS(SELECT 1 FROM webauthn_credentials WHERE user_id=u.id))
            AND EXISTS(SELECT 1 FROM admins a WHERE a.realm_id=u.realm_id AND a.email=u.email AND (a.role='platform' OR ?=0)))`,
        args: [session.hash, session.user_id, now, now, destructive ? Math.floor((now - ADMIN_FRESH_MS) / 1000) + 1 : 0,
            now - ADMIN_MFA_MS, realmId(env), session.email, session.role === 'platform' ? 1 : 0]
    };
}
// Every admin write batch rechecks the authenticating session, including after key generation.
export function mutationEnvironment(env, session, destructive) {
    return { ...env, DB: {
        // The binding itself, so per-isolate memos (JWKS, realms) forgotten during an admin write are the real ones.
        raw: env.DB.raw ?? env.DB,
        prepare: sql => env.DB.prepare(sql),
        async batch(statements) {
            const { sql, args } = adminWriteGuard(env, session, destructive, Date.now());
            const guard = env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT CASE WHEN ${sql} THEN 1 ELSE 0 END`).bind(...args);
            try { return (await env.DB.batch([guard, ...statements])).slice(1); }
            catch (error) {
                if (String(error.message).includes('admin_assertions')) invariant(false, 'conflict', 'Authorization or account changed; reload and reauthenticate.', 409);
                throw error;
            }
        }
    } };
}
