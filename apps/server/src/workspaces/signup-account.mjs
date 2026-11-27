import { msg } from '../i18n/index.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { newUserStatement } from '../services/admission.mjs';
import { mailboxClaimStatements } from '../services/access.mjs';
import { writeGuardFailed } from '../account/write-guard.mjs';
import { signupAccessGuard, signupBrowserChecks, signupGuard, signupProviderAccountGuard,
    signupProviderMethodGuard, signupSettingsGuard } from './signup-guards.mjs';
import { signupProviderEffects, signupProviderGuard } from './signup-identity.mjs';

const accountChanged = msg('Account changed; sign in again.');

export async function signupAccount(env, email, now) {
    const realm = realmId(env);
    const existing = await env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realm, email).first();
    invariant(!existing || existing.status === 'active' && !existing.merged_into, 'access_denied', 'Account unavailable.', 403);
    const owner = existing?.id ?? crypto.randomUUID();
    const guard = existing
        ? signupGuard(`EXISTS(SELECT 1 FROM users WHERE realm_id=? AND email=? AND id=? AND email_verified=?
            AND status='active' AND merged_into IS NULL)`, [realm, email, owner, existing.email_verified], 'conflict', accountChanged)
        : signupGuard('NOT EXISTS(SELECT 1 FROM users WHERE realm_id=? AND email=?)', [realm, email], 'conflict', accountChanged);
    const effects = existing
        ? existing.email_verified === 1 ? [] : mailboxClaimStatements(env, existing, now)
        : [newUserStatement(env, owner, email, true, now)];
    return { owner, guard, effects };
}

export function readSignupOwner(env, id, email) {
    return env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND id=? AND email=?').bind(realmId(env), id, email).first();
}

// A provider-only start may have reached an address that app policy already accepts. The link can
// finish ordinary mailbox sign-in and link that provider without creating a sign-up workspace.
export async function completeAdmittedProviderSignup(env, pending, signup, mode) {
    const { client } = pending, { email, provider } = signup, now = Date.now();
    const account = await signupAccount(env, email, now);
    const access = signupAccessGuard(env, client, email, now);
    const checks = [...signupBrowserChecks(env, pending, email, now), signupSettingsGuard(env, client, mode),
        signupProviderMethodGuard(env, client, provider), signupProviderAccountGuard(env, email),
        account.guard, signupProviderGuard(env, signup), { ...access, sql: `NOT (${access.sql})` }];
    const conditions = checks.map(check => '(' + check.sql + ')');
    const args = checks.flatMap(check => check.args);
    const assertion = env.DB.prepare(`INSERT INTO admin_assertions(ok) VALUES(${conditions.join(' AND ')})`).bind(...args);
    const link = signupProviderEffects(env, signup, account.owner, now, false);
    try {
        await env.DB.batch([assertion, ...account.effects, ...link.effects]);
    } catch (error) {
        if (!writeGuardFailed(error)) throw error;
        const verdict = await env.DB.prepare(`SELECT CASE ${conditions.map((sql, index) => `WHEN NOT ${sql} THEN ${index}`).join(' ')} END AS failed`)
            .bind(...args).first();
        const check = checks[verdict.failed];
        if (check) invariant(false, check.code, check.message, check.status);
        invariant(false, 'conflict', accountChanged, 409);
    }
    return readSignupOwner(env, account.owner, email);
}
