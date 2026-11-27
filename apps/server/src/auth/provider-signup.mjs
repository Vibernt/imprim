import { redirect } from '../lib/http.mjs';
import { AppError, invariant } from '../lib/errors.mjs';
import { checkEmailCookie } from './check-email-state.mjs';
import { deliverMagicLink } from './magic-delivery.mjs';
import { limitEmail } from './rate-limit.mjs';
import { signupOwnershipGuard } from '../workspaces/signup-guards.mjs';
import { completeOpenSignup } from '../workspaces/signup.mjs';
import { submitSignupApproval } from '../workspaces/signup-requests.mjs';

export async function completeProviderSignup(request, env, pending, state, profile, mode, proof, clearCookie) {
    const signup = { email: profile.email, workspace_name: state.workspace_name, provider: state.provider,
        provider_id: profile.providerId, provider_login: profile.login ?? null };
    const id = encodeURIComponent(pending.row.id);
    if (proof === 'mailbox') {
        if (mode === 'open') return completeOpenSignup(env, pending, signup, profile.hd);
        const location = await submitSignupApproval(env, env.CTX, pending, signup, profile.hd);
        return redirect(location, [clearCookie]);
    }

    const ownership = signupOwnershipGuard(env, pending.client, signup.email);
    invariant(await env.DB.prepare(`SELECT 1 WHERE ${ownership.sql}`).bind(...ownership.args).first(),
        ownership.code, ownership.message, ownership.status);
    invariant(env.EMAIL?.send && env.EMAIL_FROM, 'email_config', 'Transactional email is not configured.', 503);
    invariant(await limitEmail(env, signup.email, request), 'rate_limit', 'Too many requests.', 429);
    try {
        await deliverMagicLink(env, pending, pending.row.browser_hash, { ...signup, purpose: 'signup' });
    } catch {
        throw new AppError(500, 'server_error', 'The request could not be completed.');
    }
    return redirect(`${env.ISSUER}/check-email?request_id=${id}`, [checkEmailCookie(pending.row.id, signup.email), clearCookie]);
}
