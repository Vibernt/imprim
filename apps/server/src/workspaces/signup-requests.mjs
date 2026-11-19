import { localeOf } from '../i18n/index.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { signupAccessGuard, signupBrowserChecks, signupGuard, signupOwnershipGuard, signupSettingsGuard } from './signup-guards.mjs';
import { signupName } from './signup.mjs';

export const signupRequestLifetime = 30 * 86400000;

export async function recordSignupRequest(env, pending, { email, workspace_name }) {
    const { client } = pending, now = Date.now(), realm = realmId(env), id = crypto.randomUUID();
    const workspaceName = signupName(email, workspace_name);
    const activeAccount = signupGuard(`NOT EXISTS(SELECT 1 FROM users WHERE realm_id=? AND email=?
        AND (status<>'active' OR merged_into IS NOT NULL))`, [realm, email], 'access_denied', 'Account unavailable.', 403);
    const guards = [signupSettingsGuard(env, client, 'approval'), ...signupBrowserChecks(env, pending, email, now),
        activeAccount, signupOwnershipGuard(env, client, email), signupAccessGuard(env, client, email, now)];
    const conditions = guards.map(guard => `(${guard.sql})`);
    const args = guards.flatMap(guard => guard.args);
    const [insert, verdict] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO signup_requests(id,realm_id,client_id,product,email,workspace_name,locale,created,verified_at)
            SELECT ?,?,?,?,?,?,?,?,? WHERE ${conditions.join(' AND ')}
            ON CONFLICT(realm_id,email,product) WHERE status='pending' DO NOTHING`)
            .bind(id, realm, client.id, client.product, email, workspaceName, localeOf(env), now, now, ...args),
        env.DB.prepare(`SELECT CASE ${conditions.map((condition, index) => `WHEN NOT ${condition} THEN ${index}`).join(' ')} END AS failed`)
            .bind(...args)
    ]);
    const failure = verdict.results[0].failed;
    if (failure !== null) {
        const { code, message, status } = guards[failure];
        invariant(false, code, message, status);
    }
    return insert.meta.changes === 1 ? { id, email, workspace_name: workspaceName, product: client.product } : null;
}

export function expireSignupRequests(env, now) {
    return env.DB.prepare(`UPDATE signup_requests SET status='expired', decided_at=?
        WHERE id IN (SELECT id FROM signup_requests WHERE status='pending' AND verified_at<=? ORDER BY verified_at LIMIT 5000)`)
        .bind(now, now - signupRequestLifetime).run();
}

export const signupAlreadyDecided = 'This sign-up request was already decided or has expired.';
export const pendingSignupSql = "realm_id=? AND id=? AND status='pending' AND verified_at>?";
