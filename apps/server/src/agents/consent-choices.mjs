import { realmId } from '../realms/realm.mjs';
import { invariant } from '../lib/errors.mjs';
import { msg } from '../i18n/index.mjs';
import { catalogueHasScope } from './policy.mjs';

const replacements = `FROM agent_grants g JOIN clients c ON c.id=g.app_id
    WHERE g.user_id=? AND c.realm_id=? AND g.client_id=? AND g.app_id=? AND g.resource=?
    AND (g.workspace_id IS NOT NULL)=?
    AND g.revoked_at IS NULL AND g.expires_at>? ORDER BY g.created DESC,g.id DESC LIMIT 5`;
const replacementArgs = (env, row, userId, now, choosing) => [userId, realmId(env), row.agent_client_id, row.client_id, row.resource, Number(choosing), now];

function scopeOptions(row, grants, settings) {
    const scopes = new Map(row.scope.split(' ').map(scope => [scope, false]));
    for (const grant of grants) {
        for (const scope of grant.scope.split(' ')) {
            if (!scopes.has(scope) && catalogueHasScope(settings, scope)) scopes.set(scope, true);
        }
    }
    return scopes;
}

export async function consentChoices(env, row, { settings }, userId, choosing) {
    // Anyone can start a device flow with a public client ID. It must never replace grants or carry their scopes.
    const grants = row.device_hash ? [] : (await env.DB.prepare(
        `SELECT g.id,g.label,g.client_name,g.approved_device,g.approved_location,g.created,g.scope,g.workspace_id,
            (SELECT w.name FROM workspaces w WHERE w.id=g.workspace_id AND w.realm_id=c.realm_id) AS workspace_name ${replacements}`)
        .bind(...replacementArgs(env, row, userId, Date.now(), choosing)).all()).results;
    return { grants, scopes: scopeOptions(row, grants, settings), settings };
}

export function requireChoice(env, row, valid, message) {
    if (!valid) env.RETRY = { label: msg('Choose again'), href: '/agent/consent?request_id=' + encodeURIComponent(row.id) };
    invariant(valid, 'invalid_request', message);
}

const replacementMessage = msg('That connection can no longer be replaced.');
export const requireReplacement = (env, row, valid) => requireChoice(env, row, valid, replacementMessage);
export const requireReplacementWorkspace = (env, row, valid) =>
    requireChoice(env, row, valid, msg('That connection is for another workspace.'));
export const requireOfferedPermissions = (env, row, valid) =>
    requireChoice(env, row, valid, msg('That permission was not offered.'));

export function chosenPermissions(env, row, { grants, scopes, settings }, body, workspaceId) {
    const replace = body.replace || '';
    const replacement = replace && grants.find(grant => grant.id === replace);
    requireReplacement(env, row, !replace || replacement);
    if (replacement) requireReplacementWorkspace(env, row, replacement.workspace_id === workspaceId);
    const allowed = workspaceId === null ? scopes : scopeOptions(row, grants.filter(grant => grant.workspace_id === workspaceId), settings);
    const selected = new Set(body.scope);
    requireChoice(env, row, selected.size > 0, msg('Choose at least one permission.'));
    requireOfferedPermissions(env, row, selected.size === body.scope.length && body.scope.every(scope => allowed.has(scope)));
    const approved = [...allowed.keys()].filter(scope => selected.has(scope));
    return { scope: approved.join(' '), replace, inherited: approved.filter(scope => allowed.get(scope)) };
}

export const replacementGuard = (env, row, userId, now, id, workspaceId) => id ? {
    sql: `EXISTS(SELECT 1 FROM (SELECT g.id,g.workspace_id ${replacements}) offered WHERE offered.id=? AND offered.workspace_id IS ?)`,
    args: [...replacementArgs(env, row, userId, now, workspaceId !== null), id, workspaceId]
} : { sql: '1', args: [] };

export const workspacePermissionsGuard = (env, row, userId, now, workspaceId, scopes) => workspaceId && scopes.length ? {
    sql: `NOT EXISTS(SELECT 1 FROM json_each(?) approved WHERE NOT EXISTS(
        SELECT 1 FROM (SELECT g.workspace_id,g.scope ${replacements}) offered WHERE offered.workspace_id=?
        AND instr(' '||offered.scope||' ', ' '||approved.value||' ')>0))`,
    args: [JSON.stringify(scopes), ...replacementArgs(env, row, userId, now, true), workspaceId]
} : { sql: '1', args: [] };
