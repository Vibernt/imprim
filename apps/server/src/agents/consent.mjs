import { invariant } from '../lib/errors.mjs';
import { readBody, uniqueParams, redirect } from '../lib/http.mjs';
import { getSession, requireCsrf } from '../auth/session.mjs';
import { pendingRequest, authorizationResponse } from '../oidc/requests.mjs';
import { page } from '../pages/layout.mjs';
import { result, linkButton } from '../pages/ui.mjs';
import { validateAgentRequest } from './authorize.mjs';
import { consentWorkspaceName } from './policy.mjs';
import { workspace } from './uris.mjs';
import { admitSession } from '../services/admission.mjs';
import { mfaGate } from '../auth/mfa.mjs';
import { notify } from '../services/notify.mjs';
import { t } from '../i18n/index.mjs';
import { agentAssurance, consentPage } from './consent-page.mjs';
import { chosenPermissions, consentChoices } from './consent-choices.mjs';
import { answerConsent } from './consent-write.mjs';
export { MAX_LIVE_GRANTS } from './consent-write.mjs';
export { hidden } from '../pages/ui.mjs';

export async function consent(request, env) {
    const post = request.method === 'POST';
    // Scope names can be 100 characters long. Allow for 100 percent-encoded scope values in the form.
    const body = post ? await readBody(request, 'form', 32768, ['scope']) : uniqueParams(new URL(request.url).searchParams);
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    if (post) await requireCsrf(request, env, session, body.csrf);
    const { row } = await pendingRequest(env, request, body.request_id);
    invariant(row.agent_client_id, 'invalid_request', 'Agent request required.');
    const context = await validateAgentRequest(env, row, session);
    await admitSession(env, context.app, session);
    const workspaceName = await consentWorkspaceName(env, context.app, row.resource, session.user_id);
    const gate = await mfaGate(env, request, { client: context.app, session, row, agent: true });
    if (gate) return redirect(`${env.ISSUER}${gate}`);
    if (!post) return consentPage(request, env, row, context, workspaceName, await consentChoices(env, row, context, session.user_id));
    invariant(['approve','deny'].includes(body.decision), 'invalid_request', 'Choose Approve or Deny.');
    const approve = body.decision === 'approve';
    const approval = approve ? {
        ...chosenPermissions(env, row, await consentChoices(env, row, context, session.user_id), body),
        assurance: agentAssurance(row, context.agent, context.method)
    } : null;
    const { code, now } = await answerConsent(env, row, context, session, approval);
    if (approve) {
        await env.DB.prepare('UPDATE agent_clients SET last_used=? WHERE id=?').bind(now, row.agent_client_id).run();
        notify(env, env.CTX, session.email, 'agent_connected', { agent: context.agent.client_name, app: JSON.parse(context.app.branding).name || context.app.id, workspace: workspace(row.resource), scopes: approval.scope },
            { links: { agents_url: `${env.ISSUER}/account/agents` } });
    }
    if (row.device_hash) return approve
        ? page(t(env, 'Agent connected'), result('circle-check', 'success', t(env, 'Agent connected'), t(env, 'Go back to your device to continue.')) + linkButton(t(env, 'See connected agents'), '/account/agents', { variant: 'outline', size: 'lg', block: true }))
        : page(t(env, 'Connection denied'), result('ban', 'neutral', t(env, 'Connection denied'), t(env, 'The agent gets no access. Go back to your device.')));
    return authorizationResponse(env, row, approve ? { code } : { error: 'access_denied' });
}
