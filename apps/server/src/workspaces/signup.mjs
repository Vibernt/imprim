import { addProducts, addWorkspaceOwner, guardedWrite, workspaceId } from './model.mjs';
import { signupAccessGuard, signupBrowserChecks, signupOwnershipGuard, signupSettingsGuard,
    signupAccountRoleGuard, signupProviderMethodGuard } from './signup-guards.mjs';
import { signupProviderEffects, signupProviderGuard } from './signup-identity.mjs';
import { readSignupOwner, signupAccount } from './signup-account.mjs';

export function signupName(email, name) {
    const suffix = "'s workspace";
    return name ?? [...email.split('@')[0]].slice(0, 120 - suffix.length).join('') + suffix;
}

export async function completeOpenSignup(env, pending, signup, hostedDomain) {
    const now = Date.now();
    const checks = signupBrowserChecks(env, pending, signup.email, now);
    if (signup.provider) checks.push(signupProviderMethodGuard(env, pending.client, signup.provider, hostedDomain));
    const { owner } = await createSignupWorkspace(env, pending.client, signup, { now, mode: 'open', checks });
    return readSignupOwner(env, owner, signup.email);
}

// Callers have mailbox proof from an email link, an authoritative provider, or a verified approval request.
export async function createSignupWorkspace(env, client, signup, {
    now, mode, checks, approver, requestId, decisionEffects = []
}) {
    const { email, workspace_name, provider } = signup;
    const id = workspaceId();
    const { owner, guard, effects } = await signupAccount(env, email, now);
    const providerChecks = [];
    if (provider && !requestId) providerChecks.push(signupProviderGuard(env, signup));
    const link = provider ? signupProviderEffects(env, signup, owner, now, Boolean(requestId)) : { effects: [] };
    const workspace = await guardedWrite(env, {
        client, id, now,
        checks: [...checks, signupSettingsGuard(env, client, mode), signupOwnershipGuard(env, client, email),
            guard, signupAccountRoleGuard(env, email), ...providerChecks, signupAccessGuard(env, client, email, now)],
        create: { kind: 'team', name: signupName(email, workspace_name), owner: null, via: 'signup' },
        effects: [...effects, ...link.effects, addProducts(env, id, [client.product], now), addWorkspaceOwner(env, id, owner, now),
            env.DB.prepare(`INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,?,?,'workspace')
                ON CONFLICT(user_id,client_id) DO NOTHING`).bind(owner, client.id, now), ...decisionEffects],
        event: 'workspace-member-added', eventOptions: { userId: owner, payload: { role: 'owner' } },
        audit: 'workspace_signup', auditActor: approver ?? owner, auditFlags: link.auditFlags,
        detail: { method: provider ?? 'email', ...(requestId ? { signup_request_id: requestId, owner } : {}) }
    });
    return { ...workspace, owner };
}
