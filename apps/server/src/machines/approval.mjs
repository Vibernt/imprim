import { catalogueHasScope } from '../agents/policy.mjs';
import { agentSettings } from '../agents/settings.mjs';
import { mfaGate } from '../auth/mfa.mjs';
import { getSession, requireCsrf } from '../auth/session.mjs';
import { useLocale } from '../i18n/index.mjs';
import { invariant } from '../lib/errors.mjs';
import { readBody, redirect, uniqueParams } from '../lib/http.mjs';
import { getClient } from '../oidc/clients.mjs';
import { signedOutPage } from '../pages/layout.mjs';
import { realmId } from '../realms/realm.mjs';
import { notify } from '../services/notify.mjs';
import { machineApprovalPage, machineResultPage } from './approval-page.mjs';
import { answerMachineRequest, machineRequestHref, unansweredMachine } from './approval-write.mjs';
import { machineAdminSql, machineWorkspaceSql, offeredMachineResourcesSql } from './workspace-clients.mjs';

export async function machineApproval(request, env) {
    const post = request.method === 'POST';
    const body = post ? await readBody(request, 'form') : uniqueParams(new URL(request.url).searchParams);
    const session = await getSession(request, env);
    if (post) {
        invariant(session, 'login_required', 'Sign in first.', 401);
        await requireCsrf(request, env, session, body.csrf);
    }
    const id = body.request_id;
    const row = typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? await env.DB.prepare(`SELECT r.*,w.name AS workspace_name,
        (${machineAdminSql('r', '?')}) AS permitted,(${machineWorkspaceSql('r', { agent: true })}) AS eligible
        FROM machine_client_requests r JOIN workspaces w ON w.id=r.workspace_id AND w.realm_id=r.realm_id
        WHERE r.id=? AND r.realm_id=? AND r.status='pending' AND r.expires_at>?`)
        .bind(session?.user_id ?? null, id, realmId(env), Date.now()).first() : null;
    if (row) env.SIGN_IN = { app: row.app_id };
    if (!session) return signedOutPage(env);
    invariant(row, 'invalid_request', unansweredMachine);
    invariant(row.permitted, 'access_denied', 'Only an owner or admin of {workspace} can approve this.', 403, { workspace: row.workspace_name });
    invariant(row.eligible, 'access_denied', 'Workspace or app policy changed.', 403);
    const app = await getClient(env, row.app_id);
    useLocale(env, { client: app, user: session.locale });
    const gate = await mfaGate(env, request, { client: app, session, agent: true, next: machineRequestHref(id) });
    if (gate) return redirect(`${env.ISSUER}${gate}`);

    const settings = agentSettings(app), appName = JSON.parse(app.branding).name || app.id;
    const offered = await env.DB.prepare(`SELECT 1 FROM machine_client_requests r WHERE r.id=?
        AND ${offeredMachineResourcesSql('r', 'r.resources', '?')}`).bind(row.id, app.agent_workspace_resources).first();
    invariant(offered && JSON.parse(row.scopes).every(scope => catalogueHasScope(settings, scope)),
        'invalid_request', 'The requested permissions changed. Start again from the app.');
    if (!post) {
        const { results } = await env.DB.prepare(`SELECT resource,name FROM workspace_resources
            WHERE workspace_id=? AND client_id=? AND resource IN (SELECT value FROM json_each(?))`)
            .bind(row.workspace_id, app.id, row.resources).all();
        return machineApprovalPage(request, env, row, app, appName, settings.agent_scope_catalogue, new Map(results.map(r => [r.resource, r.name])));
    }
    invariant(['approve', 'deny'].includes(body.decision), 'invalid_request', 'Choose Approve or Deny.');
    const approved = body.decision === 'approve';
    await answerMachineRequest(env, row, app, session, approved);
    if (approved) notify(env, env.CTX, session.email, 'machine_client_approved',
        { machine: row.name, app: appName, workspace: row.workspace_name, scopes: JSON.parse(row.scopes).join(' ') },
        { locale: session.locale, links: { agents_url: `${env.ISSUER}/account/agents` } });
    return machineResultPage(env, approved, app, appName);
}
