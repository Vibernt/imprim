import { pendingRequest, requireAuthorizationAccount, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { audit } from '../services/audit.mjs';
import { noAccountPage } from '../pages/signup.mjs';
import { inspectProviderIdentity, signInProviderIdentity } from './provider-identity.mjs';
import { completeProviderSignup } from './provider-signup.mjs';
import { getSession, issueSession } from './session.mjs';
import { liveSignupEnabled, requireLiveSignup } from './signup-policy.mjs';
import { reportSignInRefusal, signInRefusal } from './sign-in-refusals.mjs';
import { notInvitedPage, platformAddressPage } from '../pages/sign-in-refusal.mjs';

export async function completeProviderCallback(request, env, state, profile, clearCookie) {
    // The exchange is complete. Re-read the browser request and app policy before any account effects.
    const pending = await pendingRequest(env, request, state.request_id);
    const { row, client } = pending, method = state.provider;
    env.SIGN_IN_ATTEMPT.email = profile.email;
    requireMethod(client, method, profile.hd, true);
    env.SIGN_IN_ATTEMPT.audit = true;
    const signup = state.purpose === 'signup', mode = signup ? await requireLiveSignup(env, pending) : null;
    let identity;
    try {
        identity = await inspectProviderIdentity(env, client, method, profile, pending);
    } catch (error) {
        if (error.signInReason !== 'admin_address') throw error;
        await reportSignInRefusal(env, 'admin_address', error.signInEmail);
        return platformAddressPage(env, pending, [clearCookie]);
    }
    const { matching, linked, allowed, join } = identity;
    const available = !matching || (matching.status === 'active' && !matching.merged_into);
    const sameOwner = !linked || linked.id === matching?.id;
    if (signup) {
        if (!available || !sameOwner) throw signInRefusal('account_unavailable', profile.email);
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
            if (!sameOwner) throw signInRefusal('account_unavailable', profile.email);
            requireAuthorizationAccount(row, linked?.id ?? matching?.id);
            if (identity.proof === 'claim' && !linked) throw signInRefusal('not_invited', identity.email);
            await reportSignInRefusal(env, 'not_invited', identity.email);
            if (!row.agent_client_id && await liveSignupEnabled(env, client))
                return noAccountPage(env, pending, identity.email, clearCookie);
            return notInvitedPage(env, pending, identity.email, [clearCookie]);
        }
    } else {
        requireAuthorizationAccount(row, linked?.id ?? matching?.id);
        const session = await getSession(request, env, { touch: false });
        if (identity.needsLink && session?.user_id !== matching.id) await reportSignInRefusal(env, 'account_unavailable', identity.email);
        user = await signInProviderIdentity(env, client, method, profile, identity, session);
    }

    const signed = await issueSession(env, user, method, profile.hd);
    await audit(env, 'sign_in', user.id, { method });
    return completeAuthorization(env, request, row.id, signed.session, [...signed.cookies, clearCookie]);
}
