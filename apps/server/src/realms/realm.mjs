// A realm is one brand: its own issuer host, keys, users, provider credentials, email sender and admins.
// The request host selects the realm before any route runs; everything downstream reads the scoped env.
import { invariant } from '../lib/errors.mjs';
// Secrets are never stored in D1: a secret field must name a Worker secret as {"env":"NAME"}.
const SECRET_FIELDS = [['turnstile', 'secret'], ['providers', 'github', 'client_secret'], ['providers', 'google', 'client_secret']];
const isRef = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.env === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.env);
const at = (object, path) => path.reduce((value, key) => value?.[key], object);
export function validateRealmConfig(config) {
    const fail = message => invariant(false, 'realm_config', message, 400);
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('Realm config must be an object.');
    const known = { email: ['from', 'from_name', 'reply_to'], turnstile: ['site_key', 'secret'], providers: ['github', 'google'] };
    for (const [section, value] of Object.entries(config)) {
        if (!known[section]) fail(`Unknown realm config section ${section}.`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${section} must be an object.`);
        for (const key of Object.keys(value)) if (!known[section].includes(key)) fail(`Unknown field ${section}.${key}.`);
    }
    for (const provider of Object.values(config.providers || {}))
        for (const key of Object.keys(provider || {})) if (!['client_id', 'client_secret'].includes(key)) fail(`Unknown provider field ${key}.`);
    const scalar = value => value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 500) || isRef(value);
    for (const path of [['email','from'], ['email','from_name'], ['email','reply_to'], ['turnstile','site_key'], ['providers','github','client_id'], ['providers','google','client_id']])
        if (!scalar(at(config, path))) fail(`${path.join('.')} must be a string or {"env":"NAME"}.`);
    for (const path of SECRET_FIELDS) {
        const value = at(config, path);
        if (value !== undefined && !isRef(value)) fail(`${path.join('.')} is a secret: use {"env":"SECRET_NAME"}, never a literal.`);
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
    return { ...env, REALM: { id: realm.id, issuer: realm.issuer, display_name: realm.display_name }, ISSUER: realm.issuer,
        EMAIL_FROM: value(['email','from']), EMAIL_FROM_NAME: value(['email','from_name']) || realm.display_name, EMAIL_REPLY_TO: value(['email','reply_to']),
        TURNSTILE_SITE_KEY: value(['turnstile','site_key']), TURNSTILE_SECRET: value(['turnstile','secret']),
        GITHUB_CLIENT_ID: value(['providers','github','client_id']), GITHUB_CLIENT_SECRET: value(['providers','github','client_secret']),
        GOOGLE_CLIENT_ID: value(['providers','google','client_id']), GOOGLE_CLIENT_SECRET: value(['providers','google','client_secret']) };
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
