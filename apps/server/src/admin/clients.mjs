import { invariant } from '../lib/errors.mjs';
import { registeredUri } from '../oidc/clients.mjs';
import { validateSignInSettings } from '../oidc/sign-in-methods.mjs';
import { validateAgentSettings, settingNames } from '../agents/settings.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { auditStatement } from './auth.mjs';
import { validateBranding } from '../branding/tokens.mjs';
import { assetExists } from '../branding/assets.mjs';
import { realmId } from '../realms/realm.mjs';
const jsonFields = ['redirect_uris','post_logout_uris','allowed_domains','branding','sign_in_methods','google_hosted_domains','token_exchange_from',
    ...settingNames.filter(k => !['agent_access','agent_max_grant_days'].includes(k))];
export function publicClient(row) {
    const { secret_hash, ...value } = row;
    for (const field of jsonFields) value[field] = JSON.parse(value[field]);
    return { ...value, confidential: Boolean(secret_hash) };
}
export async function getAdminClient(env, id) {
    const row = await env.DB.prepare('SELECT * FROM clients WHERE id=? AND realm_id=?').bind(id, realmId(env)).first();
    invariant(row, 'not_found', 'Client not found.', 404);
    return publicClient(row);
}
export const workspaceSettingNames = ['product', 'workspaces', 'personal_workspaces', 'workspace_admin', 'initiate_login_uri'];
export const validProduct = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(value);
function validateWorkspaceSettings({ product = null, workspaces = 'app', personal_workspaces = 'off', workspace_admin = 'off',
    initiate_login_uri = null, redirect_uris }) {
    invariant(product === null || validProduct(product), 'invalid_request', 'Product must be 2 to 40 lowercase letters, digits or dashes, starting with a letter.');
    invariant(['app', 'shared'].includes(workspaces), 'invalid_request', 'Workspaces must be app or shared.');
    invariant(workspaces !== 'shared' || product !== null, 'invalid_request', 'Shared workspaces require a product.');
    invariant(['off', 'on'].includes(personal_workspaces), 'invalid_request', 'Personal workspaces must be off or on.');
    invariant(['off', 'on'].includes(workspace_admin), 'invalid_request', 'Workspace administration must be off or on.');
    invariant(workspaces === 'shared' || (personal_workspaces === 'off' && workspace_admin === 'off'),
        'invalid_request', 'Personal workspaces and workspace administration require shared workspaces.');
    if (initiate_login_uri === null) return;
    const message = 'The initiate login URL must be HTTPS, without credentials, and use a registered redirect URL’s origin.';
    invariant(typeof initiate_login_uri === 'string' && /^https:\/\/[^/]/i.test(initiate_login_uri) && !/[\s\\\x00-\x1f\x7f]/.test(initiate_login_uri),
        'invalid_request', message);
    let url;
    try { url = new URL(initiate_login_uri); } catch { invariant(false, 'invalid_request', message); }
    invariant(!url.username && !url.password && redirect_uris.some(uri => new URL(uri).origin === url.origin), 'invalid_request', message);
}
// Shared with scripts/seed-client.mjs. The redirect URLs have already been validated.
export function validatePolicySettings(config, agent) {
    validateWorkspaceSettings(config);
    invariant(['off','optional','required'].includes(config.mfa ?? 'off') && ['off','required'].includes(config.agent_consent_mfa ?? 'off') &&
        Number.isInteger(config.mfa_trusted_device_days ?? 0) && (config.mfa_trusted_device_days ?? 0) >= 0 && (config.mfa_trusted_device_days ?? 0) <= 90,
        'invalid_request', 'mfa is off, optional or required; agent_consent_mfa is off or required; mfa_trusted_device_days is 0 to 90.');
    invariant(['optional', 'required'].includes(config.agent_dpop ?? 'optional'), 'invalid_request', 'agent_dpop is optional or required.');
    invariant(['off', 'on'].includes(config.user_events ?? 'off'), 'invalid_request', 'user_events is off or on.');
    invariant(['off', 'on'].includes(config.classic_oidc ?? 'off'), 'invalid_request', 'classic_oidc is off or on.');
    invariant(['ES256', 'RS256'].includes(config.id_token_signed_response_alg ?? 'ES256'), 'invalid_request', 'id_token_signed_response_alg is ES256 or RS256.');
    invariant(Number.isInteger(config.agent_token_rate ?? 3000) && (config.agent_token_rate ?? 3000) >= 10 && (config.agent_token_rate ?? 3000) <= 100000,
        'invalid_request', 'agent_token_rate is a whole number of token requests per agent per minute, 10 to 100000.');
    const exchange = config.token_exchange_from ?? {};
    invariant(exchange && typeof exchange === 'object' && !Array.isArray(exchange) && Object.keys(exchange).length <= 20 &&
        Object.entries(exchange).every(([id, scopes]) => /^[A-Za-z0-9_-]{1,200}$/.test(id) && id !== config.id && Array.isArray(scopes) && scopes.length > 0 &&
            scopes.every(scope => Object.hasOwn(agent.agent_scope_catalogue, scope))), 'invalid_request', 'token_exchange_from maps other client ids to scopes from this app\'s catalogue.');
}
function validate(config) {
    invariant(typeof config.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(config.id), 'invalid_request', 'Invalid client id.');
    const { methods, domains } = validateSignInSettings(config.sign_in_methods, config.google_hosted_domains);
    const agent = validateAgentSettings(config);
    invariant(['invited','open'].includes(config.signup_policy) && [0,1].includes(config.dev), 'invalid_request', 'Invalid signup policy or dev flag.');
    // Leaving out PKCE is safe only with a client secret: a public app always uses PKCE.
    invariant(config.classic_oidc !== 'on' || config.confidential !== false, 'invalid_request', 'Classic OpenID Connect needs a confidential app.');
    for (const name of ['redirect_uris','post_logout_uris']) {
        invariant(Array.isArray(config[name]) && config[name].length <= 100 && (name !== 'redirect_uris' || config[name].length), 'invalid_request', 'Invalid URI list.');
        for (const uri of config[name]) registeredUri({ dev: config.dev, [name]: JSON.stringify(config[name]) }, uri, name);
    }
    validatePolicySettings(config, agent);
    invariant(typeof config.backchannel_uri === 'string' && config.backchannel_uri.length > 0, 'invalid_request', 'A back-channel URI is required for session termination.');
    registeredUri({ redirect_uris: JSON.stringify([config.backchannel_uri]), dev: 0 }, config.backchannel_uri);
    validateSignInSettings(methods, config.allowed_domains);
    // App branding overrides the realm's fields and look, key by key.
    validateBranding(config.branding, { app: true });
    const value = { ...config, sign_in_methods: methods, google_hosted_domains: domains, ...agent };
    delete value.confidential;
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, jsonFields.includes(k) ? JSON.stringify(v) : v]));
}
export async function saveClient(env, actor, id, input) {
    const old = id ? await getAdminClient(env, id) : null;
    const allowed = ['id','redirect_uris','post_logout_uris','backchannel_uri','signup_policy','allowed_domains','branding','dev',
        'sign_in_methods','google_hosted_domains','mfa','mfa_trusted_device_days','agent_consent_mfa','agent_dpop','token_exchange_from','user_events','classic_oidc','id_token_signed_response_alg','agent_token_rate',
        ...settingNames, ...workspaceSettingNames, ...(old ? ['version'] : [])];
    invariant(Object.keys(input).every(k => allowed.includes(k)), 'invalid_request', 'Unknown client field; secrets cannot be supplied.');
    invariant(!id || input.id === undefined || input.id === id, 'invalid_request', 'Client id cannot change.');
    if (old) {
        invariant(Number.isSafeInteger(input.version) && input.version >= 0, 'invalid_request', 'The client version is required.');
        invariant(input.version === old.version, 'conflict', 'Client changed; reload before editing.', 409);
    }
    const config = { redirect_uris: [], post_logout_uris: [], backchannel_uri: null, signup_policy: 'invited',
        allowed_domains: [], branding: { name: '' }, dev: 0, sign_in_methods: ['email'], google_hosted_domains: [], ...old, ...input };
    let value;
    try {
        value = validate(config);
        for (const key of ['logo_light', 'logo_dark', 'mark']) if (config.branding?.[key]) invariant(await assetExists(env, config.branding[key]), 'branding', `branding.${key} is not an uploaded asset.`);
    }
    catch (error) {
        if (error.code || error instanceof TypeError) invariant(false, 'invalid_request', 'Invalid client configuration: ' + (error.code ? error.message : 'malformed field.'));
        throw error;
    }
    value.version = old ? old.version + 1 : 0;
    delete value.realm_id;
    if (!old) value.realm_id = realmId(env);
    const secret = old ? null : randomToken();
    if (!old) value.secret_hash = await sha256(secret);
    const fields = Object.keys(value).filter(k => k !== 'id');
    const statement = old
        ? env.DB.prepare(`UPDATE clients SET ${fields.map(k => `${k}=?`).join(',')} WHERE id=? AND version=? AND realm_id=?`).bind(...fields.map(k => value[k]), id, old.version, realmId(env))
        : env.DB.prepare(`INSERT INTO clients(${Object.keys(value).join(',')}) VALUES(${Object.keys(value).map(() => '?').join(',')})`).bind(...Object.values(value));
    // The detail records field names only: no secrets, hashes, credentials or URI query strings.
    // Turning agent access off revokes every live grant for the app and notifies it, in the same transaction (S12).
    // Turning it back on revives nothing: each person connects their agent again.
    const disabling = old?.agent_access === 'on' && value.agent_access === 'off';
    try {
        await env.DB.batch([...(old ? [versionGuard(env, id, old.version)] : []), statement,
            ...(disabling ? revokeAppGrants(env, id) : []),
            auditStatement(env, actor, old ? 'admin_client_update' : 'admin_client_create', value.id, { fields: Object.keys(input).filter(k => k !== 'id'), ...(disabling ? { revoked_agent_grants: true } : {}) })]);
    } catch (error) {
        if (String(error.message).includes('admin_assertions')) invariant(false, 'conflict', 'Client changed; reload before editing.', 409);
        if (String(error.message).includes('UNIQUE constraint')) invariant(false, 'conflict', 'Client already exists.', 409);
        throw error;
    }
    return { client: await getAdminClient(env, value.id), ...(secret ? { client_secret: secret } : {}) };
}
function revokeAppGrants(env, appId) {
    const now = Date.now();
    return [
        env.DB.prepare(`INSERT INTO agent_revocation_outbox(id,grant_id,app_id,user_id,resource,uri,created)
            SELECT lower(hex(randomblob(16))),g.id,g.app_id,g.user_id,g.resource,coalesce(c.backchannel_uri,''),?
            FROM agent_grants g JOIN clients c ON c.id=g.app_id WHERE g.app_id=? AND g.revoked_at IS NULL AND g.expires_at>?`).bind(now, appId, now),
        env.DB.prepare('UPDATE agent_grants SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL').bind(now, appId),
        env.DB.prepare("UPDATE agent_devices SET status='denied' WHERE app_id=? AND status IN ('pending','approved')").bind(appId)
    ];
}
function versionGuard(env, id, version) {
    return env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT CASE WHEN EXISTS(
        SELECT 1 FROM clients WHERE id=? AND version=?) THEN 1 ELSE 0 END`).bind(id, version);
}
export async function rotateSecret(env, actor, id, input = {}) {
    const old = await getAdminClient(env, id);
    invariant(Object.keys(input).every(key => key === 'make_confidential') &&
        (input.make_confidential === undefined || typeof input.make_confidential === 'boolean'),
    'invalid_request', 'make_confidential must be an explicit boolean.');
    invariant(old.confidential || input.make_confidential === true, 'invalid_request', 'Public client: explicitly choose make_confidential to change authentication.');
    const secret = randomToken();
    try {
        await env.DB.batch([
            versionGuard(env, id, old.version),
            env.DB.prepare('UPDATE clients SET secret_hash=?,version=version+1 WHERE id=? AND version=? AND realm_id=?').bind(await sha256(secret), id, old.version, realmId(env)),
            auditStatement(env, actor, 'admin_client_secret_rotate', id, { made_confidential: !old.confidential })
        ]);
    } catch (error) {
        if (String(error.message).includes('admin_assertions')) invariant(false, 'conflict', 'Client changed; reload before rotating.', 409);
        throw error;
    }
    return { id, client_secret: secret };
}
