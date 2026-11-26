import { invariant } from '../lib/errors.mjs';
import { getClient } from '../oidc/clients.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { agentSettings } from './settings.mjs';
import { resourceUrl, underPrefix } from './uris.mjs';
import { resolveAgent } from './registration.mjs';
import { realmId } from '../realms/realm.mjs';
import { workspaceClientSql } from '../workspaces/access.mjs';
export const catalogueHasScope = (settings, scope) => Object.hasOwn(settings.agent_scope_catalogue, scope);
export async function ownerOf(env, resource) {
    resourceUrl(resource);
    const { results } = await env.DB.prepare('SELECT * FROM clients WHERE realm_id=?').bind(realmId(env)).all();
    const owners = results.filter(app => agentSettings(app).agent_resource_prefixes.some(prefix => underPrefix(resource, prefix)));
    invariant(owners.length === 1, 'invalid_target', 'Resource must belong to exactly one registered app.');
    return owners[0];
}
export async function checkPolicy(env, values, session) {
    const app = await ownerOf(env, values.resource);
    invariant(!values.app_id || values.app_id === app.id, 'invalid_target', 'Resource owner changed.');
    const settings = agentSettings(app);
    invariant(settings.agent_access === 'on', 'access_denied', 'Agent access is disabled.', 403);
    const method = values.client_id?.startsWith('https://') ? 'metadata_document' : 'dynamic';
    invariant(settings.agent_registration_methods.includes(method), 'access_denied', 'Registration method is not allowed.', 403);
    // The allowlist narrows which client IDs may ask; it does not authenticate them. Only private_key_jwt does (S1).
    // Host entries match the full host, so an entry never admits another port on the same name (S9).
    invariant(!settings.agent_allowlist.length || (method === 'metadata_document' && settings.agent_allowlist.some(entry =>
        entry === values.client_id || entry === new URL(values.client_id).host)), 'access_denied', 'Agent is not allowlisted.', 403);
    const scopes = (values.scope || '').split(' ');
    invariant(scopes.length > 0 && new Set(scopes).size === scopes.length && scopes.every(scope => catalogueHasScope(settings, scope)), 'invalid_scope', 'Request scopes from the app catalogue.');
    const agent = await resolveAgent(env, values.client_id);
    // Network I/O has finished: reread owner settings before making a decision.
    const current = await getClient(env, app.id);
    invariant(JSON.stringify(agentSettings(current)) === JSON.stringify(settings), 'access_denied', 'App policy changed. Start again.', 403);
    if (session) requireMethod(current, session.method, session.google_hd, true);
    return { app: current, agent, settings, method };
}

const registeredWorkspace = `SELECT w.id,w.name FROM workspace_resources wr
    JOIN workspaces w ON w.id=wr.workspace_id JOIN clients c ON c.realm_id=w.realm_id
    WHERE wr.resource=? AND c.id=? AND c.realm_id=? AND w.status='active' AND ${workspaceClientSql('c')}`;
const workspaceMember = `EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=registered.id AND m.user_id=?)`;
export function requireWorkspaceMember(allowed) {
    invariant(allowed, 'access_denied', 'Join this workspace before connecting an agent.', 403);
}
export async function consentWorkspaceName(env, app, resource, userId) {
    const registered = await env.DB.prepare(`SELECT name,${workspaceMember} AS member FROM (${registeredWorkspace}) registered`)
        .bind(userId, resource, app.id, realmId(env)).first();
    requireWorkspaceMember(!registered || registered.member === 1);
    return registered?.name ?? null;
}
// Consent must still be eligible when the request is consumed and the grant inserted.
export const workspaceConsentGuard = (env, app, resource, userId) => ({
    sql: `NOT EXISTS(SELECT 1 FROM (${registeredWorkspace}) registered WHERE NOT ${workspaceMember})`,
    args: [resource, app.id, realmId(env), userId]
});
