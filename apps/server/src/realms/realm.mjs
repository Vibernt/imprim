// A realm is one brand: its own issuer host, keys, users, provider credentials, email sender and admins.
// The request host selects the realm before any route runs; everything downstream reads the scoped env.
import { invariant } from '../lib/errors.mjs';
import { validateBranding, resolveBranding, assertContrast } from '../branding/tokens.mjs';
// Secrets are never stored in D1: a secret field must name a Worker secret as {"env":"NAME"}.
const isRef = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.env === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.env);
const at = (object, path) => path.reduce((value, key) => value?.[key], object);
// Upstream providers by id. github and google keep their built-in flows; any other id names its type.
export const PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const RESERVED_METHODS = ['email', 'password', 'passkey'];
const PROVIDER_FIELDS = {
    github: { scalar: ['client_id', 'name'], secret: ['client_secret'] },
    google: { scalar: ['client_id', 'name'], secret: ['client_secret'] },
    oidc: { scalar: ['client_id', 'name', 'issuer', 'scopes', 'token_auth'], secret: ['client_secret'], list: ['trusted_domains'] },
    microsoft: { scalar: ['client_id', 'name', 'tenant'], secret: ['client_secret'], list: ['trusted_domains'] },
    apple: { scalar: ['client_id', 'name', 'team_id', 'key_id'], secret: ['private_key'] }
};
export const providerType = (id, config) => ['github', 'google'].includes(id) ? id : config?.type;
export function validateRealmConfig(config) {
    const fail = message => invariant(false, 'realm_config', message, 400);
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('Realm config must be an object.');
    const known = { email: ['from', 'from_name', 'reply_to'], turnstile: ['site_key', 'secret'] };
    const scalar = value => value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 500) || isRef(value);
    for (const [section, value] of Object.entries(config)) {
        if (section === 'branding') { validateBranding(value); assertContrast(resolveBranding(value)); continue; }
        if (!known[section] && section !== 'providers') fail(`Unknown realm config section ${section}.`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${section} must be an object.`);
        if (section !== 'providers') for (const key of Object.keys(value)) if (!known[section].includes(key)) fail(`Unknown field ${section}.${key}.`);
    }
    for (const path of [['email','from'], ['email','from_name'], ['email','reply_to'], ['turnstile','site_key']])
        if (!scalar(at(config, path))) fail(`${path.join('.')} must be a string or {"env":"NAME"}.`);
    if (at(config, ['turnstile', 'secret']) !== undefined && !isRef(config.turnstile.secret)) fail('turnstile.secret is a secret: use {"env":"SECRET_NAME"}, never a literal.');
    for (const [id, provider] of Object.entries(config.providers || {})) {
        if (!PROVIDER_ID.test(id) || RESERVED_METHODS.includes(id)) fail(`Provider id ${id}: 2-40 lowercase letters, digits or hyphens, not a built-in method.`);
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)) fail(`providers.${id} must be an object.`);
        const type = providerType(id, provider), fields = PROVIDER_FIELDS[type];
        if (!fields || (['github', 'google'].includes(type) && provider.type !== undefined && provider.type !== type) || (['github', 'google'].includes(provider.type) && id !== provider.type))
            fail(`providers.${id}.type must be oidc, microsoft or apple (github and google use their own ids).`);
        for (const key of Object.keys(provider)) if (key !== 'type' && ![...fields.scalar, ...fields.secret, ...(fields.list || [])].includes(key)) fail(`Unknown provider field ${id}.${key}.`);
        for (const key of fields.scalar) if (!scalar(provider[key])) fail(`providers.${id}.${key} must be a string or {"env":"NAME"}.`);
        for (const key of fields.secret) if (provider[key] !== undefined && !isRef(provider[key])) fail(`providers.${id}.${key} is a secret: use {"env":"SECRET_NAME"}, never a literal.`);
        for (const key of fields.list || []) if (provider[key] !== undefined && !(Array.isArray(provider[key]) && provider[key].length <= 50 && provider[key].every(d => typeof d === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(d))))
            fail(`providers.${id}.${key} must be a list of lowercase domains.`);
        if (type === 'oidc') {
            if (typeof provider.issuer !== 'string' || !/^https:\/\/[^\s?#]+$/.test(provider.issuer)) fail(`providers.${id}.issuer must be an https URL.`);
            if (provider.token_auth !== undefined && !['client_secret_basic', 'client_secret_post'].includes(provider.token_auth)) fail(`providers.${id}.token_auth is client_secret_basic or client_secret_post.`);
        }
        if (type === 'microsoft' && provider.tenant !== undefined && !/^(common|organizations|consumers|[0-9a-f-]{36})$/.test(provider.tenant)) fail(`providers.${id}.tenant is common, organizations, consumers or a tenant id.`);
    }
    return config;
}
const resolve = (env, value) => isRef(value) ? env[value.env] : value;
// Per isolate, for a minute: one D1 read per host per minute, not per request.
const memo = new WeakMap();
export const memoKey = env => env.DB.raw ?? env.DB;
export const forgetRealms = env => memo.delete(memoKey(env));
export async function realmFor(env, origin, now = Date.now()) {
    let hosts = memo.get(memoKey(env));
    if (!hosts || hosts.until <= now) {
        const { results } = await env.DB.prepare("SELECT * FROM realms WHERE issuer IS NOT NULL AND status='active'").all();
        hosts = { until: now + 60000, byOrigin: new Map(results.map(row => [row.issuer, row])) };
        memo.set(memoKey(env), hosts);
    }
    const realm = hosts.byOrigin.get(origin);
    invariant(realm, 'unknown_realm', 'This host is not an identity realm.', 404);
    return realm;
}
// The scoped env every module reads. Code never mixes realms: one request, one realm.
export function realmEnv(env, realm) {
    const config = JSON.parse(realm.config), value = path => resolve(env, at(config, path));
    return { ...env, REALM: { id: realm.id, issuer: realm.issuer, display_name: realm.display_name, branding: config.branding || {} }, ISSUER: realm.issuer,
        EMAIL_FROM: value(['email','from']), EMAIL_FROM_NAME: value(['email','from_name']) || realm.display_name, EMAIL_REPLY_TO: value(['email','reply_to']),
        TURNSTILE_SITE_KEY: value(['turnstile','site_key']), TURNSTILE_SECRET: value(['turnstile','secret']),
        GITHUB_CLIENT_ID: value(['providers','github','client_id']), GITHUB_CLIENT_SECRET: value(['providers','github','client_secret']),
        GOOGLE_CLIENT_ID: value(['providers','google','client_id']), GOOGLE_CLIENT_SECRET: value(['providers','google','client_secret']),
        // Registry providers (not github or google), with secrets resolved for this request only.
        PROVIDERS: Object.fromEntries(Object.entries(config.providers || {}).filter(([id]) => !['github', 'google'].includes(id)).map(([id, p]) =>
            [id, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? v : resolve(env, v)]))])) };
}
export function realmId(env) {
    invariant(typeof env.REALM?.id === 'string', 'realm_config', 'No realm is bound to this request.', 503);
    return env.REALM.id;
}
// Queue and cron work has no request host: it runs as the realm that owns the client (or each realm in turn).
export async function realmEnvForClient(env, clientId) {
    const realm = await env.DB.prepare('SELECT r.* FROM realms r JOIN clients c ON c.realm_id=r.id WHERE c.id=?').bind(clientId).first();
    invariant(realm?.issuer, 'realm_config', 'The client has no configured realm.', 503);
    return realmEnv(env, realm);
}
export async function configuredRealms(env) {
    return (await env.DB.prepare("SELECT * FROM realms WHERE issuer IS NOT NULL AND status='active' ORDER BY id").all()).results;
}
