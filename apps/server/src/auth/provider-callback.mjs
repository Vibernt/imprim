import { invariant } from '../lib/errors.mjs';
import { pendingRequest, requireAuthorizationAccount, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { audit } from '../services/audit.mjs';
import { noAccountPage } from '../pages/signup.mjs';
import { inspectProviderIdentity, requireProviderLink, signInProviderIdentity } from './provider-identity.mjs';
import { completeProviderSignup } from './provider-signup.mjs';
import { getSession, issueSession } from './session.mjs';
import { liveSignupEnabled, requireLiveSignup } from './signup-policy.mjs';

export async function completeProviderCallback(request, env, state, profile, clearCookie) {
    // The exchange is complete. Re-read the browser request and app policy before any account effects.
    const pending = await pendingRequest(env, request, state.request_id);
    const { row, client } = pending, method = state.provider;
    requireMethod(client, method, profile.hd, true);
    const signup = state.purpose === 'signup', mode = signup ? await requireLiveSignup(env, pending) : null;
    const identity = await inspectProviderIdentity(env, client, method, profile, pending);
    const { matching, linked, allowed, join } = identity;
    const available = !matching || (matching.status === 'active' && !matching.merged_into);
    const sameOwner = !linked || linked.id === matching?.id;
    if (signup) {
        invariant(available && sameOwner, 'access_denied', 'Account unavailable.', 403);
        requireAuthorizationAccount(row, matching?.id);
    }

    // Admission policy can accept an email even when no account exists yet. A sign-up start
    // must still prove that mailbox before creating a new user.
    const needsMailbox = signup && identity.proof === 'provider' && !matching;
    let user;
    if (needsMailbox || (!allowed && !join)) {
        if (signup) {
            const result = await completeProviderSignup(request, env, pending, state, profile, mode, identity.proof, clearCookie);
            if (result instanceof Response) return result;
            user = result;
        } else {
            if (identity.needsLink) requireProviderLink(identity, await getSession(request, env, { touch: false }));
            invariant(available && sameOwner && !row.agent_client_id &&
                await liveSignupEnabled(env, client), 'access_denied', 'Account unavailable.', 403);
            requireAuthorizationAccount(row, matching?.id);
            return noAccountPage(env, pending, profile.email, clearCookie);
        }
    } else {
        user = await signInProviderIdentity(env, client, method, profile, identity, await getSession(request, env));
    }

    const signed = await issueSession(env, user, method, profile.hd);
    await audit(env, 'sign_in', user.id, { method });
    return completeAuthorization(env, request, row.id, signed.session, [...signed.cookies, clearCookie]);
}
