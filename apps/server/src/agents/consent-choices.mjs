import { realmId } from '../realms/realm.mjs';
import { invariant } from '../lib/errors.mjs';
import { msg } from '../i18n/index.mjs';
import { catalogueHasScope } from './policy.mjs';

const replacements = `FROM agent_grants g JOIN clients c ON c.id=g.app_id
    WHERE g.user_id=? AND c.realm_id=? AND g.client_id=? AND g.app_id=? AND g.resource=?
    AND g.revoked_at IS NULL AND g.expires_at>? ORDER BY g.created DESC,g.id DESC LIMIT 5`;
const replacementArgs = (env, row, userId, now) => [userId, realmId(env), row.agent_client_id, row.client_id, row.resource, now];

export async function consentChoices(env, row, { settings }, userId) {
    // Anyone can start a device flow with a public client ID. It must never replace grants or carry their scopes.
    const grants = row.device_hash ? [] : (await env.DB.prepare(
        `SELECT g.id,g.label,g.client_name,g.approved_device,g.approved_location,g.created,g.scope ${replacements}`)
        .bind(...replacementArgs(env, row, userId, Date.now())).all()).results;
    const scopes = new Map(row.scope.split(' ').map(scope => [scope, false]));
    // validateAgentRequest has checked the app, resource, agent, and session for this request.
    // Catalogue membership is the only scope-specific rule in checkPolicy; that same policy is fenced in the batch.
    for (const grant of grants) {
        for (const scope of grant.scope.split(' ')) {
            if (!scopes.has(scope) && catalogueHasScope(settings, scope)) scopes.set(scope, true);
        }
    }
    return { grants, scopes };
}

export function requireChoice(env, row, valid, message) {
    if (!valid) env.RETRY = { label: msg('Choose again'), href: '/agent/consent?request_id=' + encodeURIComponent(row.id) };
    invariant(valid, 'invalid_request', message);
}

const replacementMessage = msg('That connection can no longer be replaced.');
export const requireReplacement = (env, row, valid) => requireChoice(env, row, valid, replacementMessage);

export function chosenPermissions(env, row, { grants, scopes }, body) {
    const selected = new Set(body.scope);
    requireChoice(env, row, selected.size > 0, msg('Choose at least one permission.'));
    requireChoice(env, row, selected.size === body.scope.length && body.scope.every(scope => scopes.has(scope)), msg('That permission was not offered.'));
    const replace = body.replace || '';
    requireReplacement(env, row, !replace || grants.some(grant => grant.id === replace));
    return { scope: [...scopes.keys()].filter(scope => selected.has(scope)).join(' '), replace };
}

export const replacementGuard = (env, row, userId, now, id) => id ? {
    sql: `? IN (SELECT g.id ${replacements})`,
    args: [id, ...replacementArgs(env, row, userId, now)]
} : { sql: '1', args: [] };
