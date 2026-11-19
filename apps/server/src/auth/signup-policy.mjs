import { invariant } from '../lib/errors.mjs';
import { allowsMethod } from '../oidc/sign-in-methods.mjs';
import { realmId } from '../realms/realm.mjs';
import { sharedClient, workspaceClientSql } from '../workspaces/access.mjs';
import { msg } from '../i18n/index.mjs';

export const signupOff = msg('Self-serve sign-up is unavailable for this app.');
const realmModeSql = "(SELECT json_extract(r.config,'$.signup') FROM realms r WHERE r.id=c.realm_id)";
export const signupSettingsSql = `${workspaceClientSql('c')} AND c.self_signup='on'
    AND EXISTS(SELECT 1 FROM json_each(c.sign_in_methods) WHERE value='email')`;
export const enabledSignupModeSql = `${realmModeSql} IN ('approval','open')`;
export const signupModeIsSql = `${realmModeSql}=?`;

export function signupEnabled(env, client) {
    return ['approval', 'open'].includes(env.REALM.signup) && env.REALM.workspaces === 'on' &&
        sharedClient(client) && client.self_signup === 'on' && allowsMethod(client, 'email');
}

export function requireSignup(env, pending) {
    invariant(pending && !pending.row.agent_client_id && signupEnabled(env, pending.client), 'access_denied', signupOff, 403);
}

export async function liveSignupMode(env, client) {
    const row = await env.DB.prepare(`SELECT ${realmModeSql} AS mode FROM clients c
        WHERE c.id=? AND c.realm_id=? AND c.product=? AND ${signupSettingsSql} AND ${enabledSignupModeSql}`)
        .bind(client.id, realmId(env), client.product).first();
    return row?.mode ?? 'off';
}

export const liveSignupEnabled = async (env, client) => signupEnabled(env, client) && await liveSignupMode(env, client) !== 'off';

export function signupWorkspaceName(value) {
    if (value === undefined) return null;
    invariant(typeof value === 'string' && !value.includes('\0') && [...value.trim()].length <= 120,
        'invalid_request', 'Enter a workspace name up to 120 characters.');
    return value.trim() || null;
}
