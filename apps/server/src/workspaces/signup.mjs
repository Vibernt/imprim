import { msg } from '../i18n/index.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { newUserStatement } from '../services/admission.mjs';
import { mailboxClaimStatements } from '../services/access.mjs';
import { addProducts, addWorkspaceOwner, guardedWrite, workspaceId } from './model.mjs';
import { signupAccessGuard, signupBrowserChecks, signupGuard, signupOwnershipGuard, signupSettingsGuard } from './signup-guards.mjs';

const accountChanged = msg('Account changed; sign in again.');
const userByEmail = (env, email) => env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realmId(env), email).first();

export function signupName(email, name) {
    const suffix = "'s workspace";
    return name ?? [...email.split('@')[0]].slice(0, 120 - suffix.length).join('') + suffix;
}

export async function completeOpenSignup(env, pending, signup) {
    const now = Date.now();
    await createSignupWorkspace(env, pending.client, signup, {
        now, mode: 'open', checks: signupBrowserChecks(env, pending, signup.email, now)
    });
    return userByEmail(env, signup.email);
}

// Both callers supply mailbox proof: open sign-up just verified a link, and approval claims a verified request.
export async function createSignupWorkspace(env, client, { email, workspace_name }, {
    now, mode, checks, approver, requestId, decisionEffects = []
}) {
    const existing = await userByEmail(env, email);
    invariant(!existing || existing.status === 'active' && !existing.merged_into, 'access_denied', 'Account unavailable.', 403);
    const id = workspaceId(), owner = existing?.id ?? crypto.randomUUID(), realm = realmId(env);
    const identity = existing
        ? signupGuard(`EXISTS(SELECT 1 FROM users WHERE realm_id=? AND email=? AND id=? AND email_verified=?
            AND status='active' AND merged_into IS NULL)`, [realm, email, owner, existing.email_verified], 'conflict', accountChanged)
        : signupGuard('NOT EXISTS(SELECT 1 FROM users WHERE realm_id=? AND email=?)', [realm, email], 'conflict', accountChanged);
    const userEffects = existing
        ? existing.email_verified === 1 ? [] : mailboxClaimStatements(env, existing, now)
        : [newUserStatement(env, owner, email, true, now)];
    return guardedWrite(env, {
        client, id, now,
        checks: [...checks, signupSettingsGuard(env, client, mode), signupOwnershipGuard(env, client, email),
            identity, signupAccessGuard(env, client, email, now)],
        create: { kind: 'team', name: signupName(email, workspace_name), owner: null, via: 'signup' },
        effects: [...userEffects, addProducts(env, id, [client.product], now), addWorkspaceOwner(env, id, owner, now),
            env.DB.prepare(`INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,?,?,'workspace')
                ON CONFLICT(user_id,client_id) DO NOTHING`).bind(owner, client.id, now), ...decisionEffects],
        event: 'workspace-member-added', eventOptions: { userId: owner, payload: { role: 'owner' } },
        audit: 'workspace_signup', auditActor: approver ?? owner, detail: requestId ? { signup_request_id: requestId, owner } : {}
    });
}
