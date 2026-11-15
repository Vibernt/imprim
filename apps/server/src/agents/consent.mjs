import { policyGuard } from './guards.mjs';
import { invariant } from '../lib/errors.mjs';
import { readBody, uniqueParams } from '../lib/http.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { cookies, getSession, requireCsrf, CSRF_COOKIE } from '../auth/session.mjs';
import { pendingRequest, authorizationResponse } from '../oidc/requests.mjs';
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { validateAgentRequest } from './authorize.mjs';
import { workspace } from './uris.mjs';
import { admitSession, admissionGuard } from '../services/admission.mjs';
import { mfaGate } from '../auth/mfa.mjs';
import { notify } from '../services/notify.mjs';
import { redirect } from '../lib/http.mjs';
// Live grants per person, across apps: each is a consent the person gave, so this only bounds runaway automation (S5).
export const MAX_LIVE_GRANTS = 50;
export const hidden = (name, value) => `<input type="hidden" name="${name}" value="${e(value)}">`;
// How much the consent screen can say about who is asking (S1, S11):
//   key      - the agent proves its client ID with private_key_jwt at the token endpoint;
//   redirect - the code is delivered only to an HTTPS address the metadata document lists;
//   claimed  - device codes and loopback redirects reach whoever started the flow, so the host is only a claim;
//   none     - dynamically registered: nothing about the name is checked.
export function agentAssurance(row, agent, method) {
    if (method !== 'metadata_document') return 'none';
    if (agent.token_endpoint_auth_method === 'private_key_jwt') return 'key';
    return !row.device_hash && row.redirect_uri?.startsWith('https://') ? 'redirect' : 'claimed';
}
const phishing = '<p role="alert"><strong>Only approve a connection you started yourself, on this device or your own, just now.</strong> If someone sent you this link or code, choose Deny: approving gives them access as you.</p>';
export function consentPage(request, env, row, context) {
    const { agent, app, settings, method } = context;
    const assurance = agentAssurance(row, agent, method), name = e(agent.client_name);
    const host = method === 'metadata_document' ? e(new URL(agent.client_id).host) : '';
    const heading = { key: `Connect ${name}`, redirect: `Connect ${name}`, claimed: `Agent calling itself “${name}”`, none: `Unverified agent calling itself “${name}”` }[assurance];
    const identity = { key: `<p>Agent host: ${host} (verified by its signing key)</p>`, redirect: `<p>Agent host: ${host} (verified by its HTTPS callback)</p>`,
        claimed: `<p>Agent host: ${host} — <strong>claimed, not verified</strong>. Any program can use this name.</p>`,
        none: '<p>This agent registered itself. Its name is not verified.</p>' }[assurance];
    const scopes = row.scope.split(' ').map(scope => `<li><strong>${e(scope)}</strong>: ${e(settings.agent_scope_catalogue[scope])}</li>`).join('');
    const brand = brandingFor(env, app), intro = brand.copy?.consent_intro;
    return page('Connect agent', `<h1>${heading}</h1>${intro ? `<p>${e(intro)}</p>` : ''}${identity}${assurance === 'key' || assurance === 'redirect' ? '' : phishing}
<p>App: ${e(brand.name || app.id)}</p><p>Workspace: ${e(workspace(row.resource))}</p>
<p>Resource: ${e(row.resource)}</p><ul>${scopes}</ul><p>Access lasts at most ${settings.agent_max_grant_days} days. The app still checks your permissions on every call.</p>
<form method="post" action="/agent/consent">${hidden('request_id', row.id)}${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}
<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`,
        { client: app, formTargets: row.device_hash || !row.redirect_uri ? [] : [row.redirect_uri] });
}
export async function consent(request, env) {
    const body = request.method === 'POST' ? await readBody(request, 'form') : uniqueParams(new URL(request.url).searchParams);
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    if (request.method === 'POST') await requireCsrf(request, env, session, body.csrf);
    const { row } = await pendingRequest(env, request, body.request_id);
    invariant(row.agent_client_id, 'invalid_request', 'Agent request required.');
    const context = await validateAgentRequest(env, row, session);
    await admitSession(env, context.app, session);
    const gate = await mfaGate(env, request, { client: context.app, session, row, agent: true });
    if (gate) return redirect(`${env.ISSUER}${gate}`);
    if (request.method === 'GET') return consentPage(request, env, row, context);
    invariant(['approve','deny'].includes(body.decision), 'invalid_request', 'Choose approve or deny.');
    const approve = body.decision === 'approve', now = Date.now(), grantId = crypto.randomUUID();
    const code = randomToken(), codeHash = await sha256(code);
    const batch = [];
    // Insert only while the browser request, session and (if present) device are still live.
    const guard = policyGuard(context.app, row.resource), admission = admissionGuard('s.user_id', context.app.id);
    const eligible = `id=? AND browser_hash=? AND expires_at>? AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.hash=? AND s.expires_at>? AND u.status='active' AND u.merged_into IS NULL AND ${admission.sql})
        AND (device_hash IS NULL OR EXISTS(SELECT 1 FROM agent_devices d WHERE d.hash=device_hash AND d.status='pending' AND d.expires_at>?)) AND ${guard.sql}`;
    const args = [row.id, row.browser_hash, now, session.hash, now, ...admission.args, now, ...guard.args];
    if (approve) {
        const live = await env.DB.prepare('SELECT count(*) AS n FROM agent_grants WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').bind(session.user_id, now).first();
        invariant(live.n < MAX_LIVE_GRANTS, 'access_denied', `You have ${MAX_LIVE_GRANTS} connected agents. Revoke one at /account first.`, 403);
    }
    if (approve) {
        batch.push(env.DB.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,google_hd,created,last_used,expires_at)
            SELECT ?,agent_client_id,?,?,client_id,?,resource,scope,?,?,?,?,? FROM auth_requests WHERE ${eligible}`)
            .bind(grantId, context.agent.client_name, context.method, session.user_id, session.method, session.google_hd,
                now, now, now + context.settings.agent_max_grant_days * 86400000, ...args));
        if (!row.device_hash) batch.push(env.DB.prepare(`INSERT INTO agent_codes(hash,grant_id,redirect_uri,challenge,session_hash,expires_at)
            SELECT ?,id,?,?,?,? FROM agent_grants WHERE id=?`).bind(codeHash, row.redirect_uri, row.challenge, session.hash, now + 60000, grantId));
        batch.push(env.DB.prepare(`INSERT INTO audit(event,actor,detail,created,realm_id) SELECT 'agent_grant',user_id,?,?,? FROM agent_grants WHERE id=?`)
            .bind(JSON.stringify({ grant_id: grantId, app_id: row.client_id, resource: row.resource }), now, env.REALM.id, grantId));
    }
    batch.push(env.DB.prepare(`DELETE FROM auth_requests WHERE ${eligible} RETURNING id`).bind(...args));
    const deleteIndex = batch.length - 1;
    if (row.device_hash) batch.push(env.DB.prepare(`UPDATE agent_devices SET status=?,grant_id=? WHERE hash=? AND status='pending' AND expires_at>? AND changes()=1`)
        .bind(approve ? 'approved' : 'denied', approve ? grantId : null, row.device_hash, now));
    const result = await env.DB.batch(batch);
    invariant(result[deleteIndex].results.length === 1 && (!approve || result[0].meta.changes === 1), 'invalid_request', 'Request already completed.');
    if (approve) {
        await env.DB.prepare('UPDATE agent_clients SET last_used=? WHERE id=?').bind(now, row.agent_client_id).run();
        notify(env, env.CTX, session.email, 'an agent was connected', `"${context.agent.client_name}" can now act for you in ${JSON.parse(context.app.branding).name || context.app.id} (${workspace(row.resource)}) with: ${row.scope}. Review or revoke it at ${env.ISSUER}/account.`);
    }
    if (row.device_hash) return page(approve ? 'Agent connected' : 'Access denied', `<h1>${approve ? 'Agent connected' : 'Access denied'}</h1><p>Return to your device.</p><a href="/account">Connected agents</a>`);
    return authorizationResponse(env, row, approve ? { code } : { error: 'access_denied' });
}
