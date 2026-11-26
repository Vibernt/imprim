import { AppError, invariant } from '../lib/errors.mjs';
import { readBody, uniqueParams, redirect } from '../lib/http.mjs';
import { getSession, requireCsrf } from '../auth/session.mjs';
import { pendingRequest, authorizationResponse } from '../oidc/requests.mjs';
import { page } from '../pages/layout.mjs';
import { result, linkButton, escapeHtml } from '../pages/ui.mjs';
import { validateAgentRequest } from './authorize.mjs';
import { consentResourceDetails } from './policy.mjs';
import { listWorkspaceChoices, requireWorkspaceChoices } from './workspace-choice.mjs';
import { workspace } from './uris.mjs';
import { admitSession } from '../services/admission.mjs';
import { mfaGate } from '../auth/mfa.mjs';
import { notify } from '../services/notify.mjs';
import { msg, t } from '../i18n/index.mjs';
import { agentAssurance, consentPage } from './consent-page.mjs';
import { chosenPermissions, consentChoices, requireChoice } from './consent-choices.mjs';
import { answerConsent } from './consent-write.mjs';
export { MAX_LIVE_GRANTS } from './consent-write.mjs';
export { hidden } from '../pages/ui.mjs';

async function consentLocation(env, row, context, session, choosing) {
    const { app } = context, userId = session.user_id;
    // Admission can accept an invitation or provision a personal workspace before the picker is read.
    try { await admitSession(env, app, session); }
    catch (error) {
        if (choosing && error instanceof AppError && error.code === 'access_denied')
            requireWorkspaceChoices(env, app, await listWorkspaceChoices(env, app, userId));
        throw error;
    }
    if (!choosing) return consentResourceDetails(env, app, row.resource, userId);
    const workspaces = await listWorkspaceChoices(env, app, userId);
    requireWorkspaceChoices(env, app, workspaces);
    return { workspaces };
}

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
    const choosing = context.settings.agent_workspace_resources.includes(row.resource);
    const location = await consentLocation(env, row, context, session, choosing);
    const gate = await mfaGate(env, request, { client: context.app, session, row, agent: true });
    if (gate) return redirect(`${env.ISSUER}${gate}`);
    if (!post) return consentPage(request, env, row, context, location, await consentChoices(env, row, context, session.user_id, choosing), session);
    invariant(['approve','deny'].includes(body.decision), 'invalid_request', 'Choose Approve or Deny.');
    const approve = body.decision === 'approve';
    const selected = choosing && approve ? location.workspaces.find(item => item.id === body.workspace_id) : null;
    if (approve) requireChoice(env, row, choosing ? selected : body.workspace_id === undefined, msg('Choose an available workspace.'));
    const approval = approve ? {
        ...chosenPermissions(env, row, await consentChoices(env, row, context, session.user_id, choosing), body, selected?.id ?? null),
        workspaceId: selected?.id ?? null,
        assurance: agentAssurance(row, context.agent, context.method)
    } : null;
    const { code, now } = await answerConsent(env, row, context, session, approval);
    if (approve) {
        await env.DB.prepare('UPDATE agent_clients SET last_used=? WHERE id=?').bind(now, row.agent_client_id).run();
        notify(env, env.CTX, session.email, 'agent_connected', { agent: context.agent.client_name, app: JSON.parse(context.app.branding).name || context.app.id,
            workspace: selected?.name ?? location.workspaceName ?? workspace(row.resource), scopes: approval.scope },
            { links: { agents_url: `${env.ISSUER}/account/agents` } });
    }
    if (row.device_hash) {
        const title = approve ? t(env, 'Agent connected') : t(env, 'Connection denied');
        return page(title, result(approve ? 'circle-check' : 'ban', approve ? 'success' : 'neutral', title,
            approve ? t(env, 'Go back to your device to continue.') : t(env, 'The agent gets no access. Go back to your device.')) +
            `<p class="fd-body">${escapeHtml(t(env, 'You can close this tab.'))}</p>` +
            (approve ? linkButton(t(env, 'See connected agents'), '/account/agents', { variant: 'outline', size: 'lg', block: true }) : ''),
            { client: context.app });
    }
    return authorizationResponse(env, row, approve ? { code } : { error: 'access_denied' });
}
