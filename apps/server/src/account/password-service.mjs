import { invariant } from '../lib/errors.mjs';
import { validatePassword } from '../auth/password-policy.mjs';
import { assertNotBreached } from '../auth/breach.mjs';
import { hashPassword, verifyPassword } from '../auth/password-hash.mjs';
import { audit } from '../services/audit.mjs';
import { notify } from '../services/notify.mjs';
import { logoutStatements, flushLogouts } from '../oidc/backchannel.mjs';
import { forgetDevices } from '../auth/mfa.mjs';
import { requireChange, writeGuardFailed } from './write-guard.mjs';

const FRESH_MS = 600000;
const freshMailbox = session => session.method === 'email' && session.auth_time * 1000 > Date.now() - FRESH_MS;
export function requirePasswordEmail(session) {
    invariant(session.email_verified === 1, 'access_denied', 'Your email isn’t confirmed yet. Sign in with an email link, then set a password.', 403);
}
const storedPassword = (env, userId) => env.DB.prepare('SELECT * FROM user_passwords WHERE user_id=?').bind(userId).first();
export async function passwordStatus(env, session) {
    const stored = await env.DB.prepare('SELECT updated FROM user_passwords WHERE user_id=?').bind(session.user_id).first();
    return { updated: stored?.updated ?? null, current_password_required: Boolean(stored) && !freshMailbox(session) };
}

export async function savePassword(env, ctx, session, body) {
    requirePasswordEmail(session);
    const stored = await storedPassword(env, session.user_id);
    // A first password needs fresh mailbox proof (an email link in the last ten minutes); a change needs that or the
    // current password.
    if (!stored) invariant(freshMailbox(session), 'reauth_required', 'Setting a first password needs an email-link sign-in in the last 10 minutes. Use Set or reset password at sign-in.', 403);
    else if (!freshMailbox(session))
        invariant(typeof body.current_password === 'string' && await verifyPassword(body.current_password, stored), 'invalid_grant', 'That isn’t your current password. Try again, or reset it from the sign-in page.', 403);
    validatePassword(body.password, session.email);
    await assertNotBreached(body.password);
    const next = await hashPassword(body.password), now = Date.now();
    // One transaction: the new hash, the end of every other session (a reset must lock out whoever else is signed
    // in), and the audit record.
    try {
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO user_passwords(user_id,algorithm,iterations,salt,hash,created,updated) SELECT ?,?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (SELECT 1 FROM user_passwords WHERE user_id=?))
                ON CONFLICT(user_id) DO UPDATE SET algorithm=excluded.algorithm,iterations=excluded.iterations,salt=excluded.salt,hash=excluded.hash,updated=excluded.updated
                WHERE user_passwords.hash=?`)
                .bind(session.user_id, next.algorithm, next.iterations, next.salt, next.hash, now, now, stored?.hash ?? null, session.user_id, stored?.hash ?? null),
            requireChange(env),
            // Everyone else signed in as this person is signed out of identity and, by back-channel, of every app.
            ...logoutStatements(env, session.user_id, null, session.sid),
            env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND hash<>?').bind(session.user_id, session.hash),
            forgetDevices(env, session.user_id),
            env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,'{}',?,?)").bind(stored ? 'password_changed' : 'password_set', session.user_id, now, env.REALM.id)
        ]);
    } catch (error) {
        if (!writeGuardFailed(error)) throw error;
        invariant(false, 'conflict', 'The password changed. Reload the page and try again.', 409);
    }
    ctx?.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
    notify(env, ctx, session.email, stored ? 'password_changed' : 'password_set', { time: now });
}
