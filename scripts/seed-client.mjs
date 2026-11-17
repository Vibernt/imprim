// Offline configuration to reviewed SQL. Never registers a client or contacts a provider.
import { validateBranding } from '../apps/server/src/branding/tokens.mjs';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateSignInSettings } from '../apps/server/src/oidc/sign-in-methods.mjs';
import { validateAgentSettings, settingNames } from '../apps/server/src/agents/settings.mjs';
import { registeredUri } from '../apps/server/src/oidc/clients.mjs';
import { validatePolicySettings } from '../apps/server/src/admin/clients.mjs';
const POLICY = ['mfa', 'mfa_trusted_device_days', 'agent_consent_mfa', 'agent_dpop', 'token_exchange_from', 'user_events', 'classic_oidc', 'id_token_signed_response_alg'];
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export function clientSeedSql(config) {
    assert(config && typeof config === 'object' && !Array.isArray(config), 'Client configuration must be an object');
    const allowed = [...settingNames, ...POLICY,'id','secret_hash','redirect_uris','post_logout_uris','backchannel_uri','signup_policy','allowed_domains','branding','dev','sign_in_methods','google_hosted_domains'];
    assert(Object.keys(config).every(key => allowed.includes(key)), 'Unknown client setting');
    assert(typeof config.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(config.id), 'Invalid client id');
    assert(config.secret_hash === null || /^[a-f0-9]{64}$/.test(config.secret_hash || ''), 'Provide a SHA-256 secret_hash or explicit null for a public client');
    const { methods, domains } = validateSignInSettings(config.sign_in_methods, config.google_hosted_domains);
    const client = { id: config.id, secret_hash: config.secret_hash, redirect_uris: JSON.stringify(config.redirect_uris),
        post_logout_uris: JSON.stringify(config.post_logout_uris ?? []), backchannel_uri: config.backchannel_uri ?? null,
        signup_policy: config.signup_policy ?? 'invited', allowed_domains: JSON.stringify(config.allowed_domains ?? []),
        branding: JSON.stringify(config.branding ?? {}), dev: config.dev ?? 0,
        sign_in_methods: JSON.stringify(methods), google_hosted_domains: JSON.stringify(domains) };
    const agent = validateAgentSettings(Object.fromEntries(settingNames.filter(key => config[key] !== undefined).map(key => [key, config[key]])));
    for (const [key, value] of Object.entries(agent)) client[key] = typeof value === 'object' ? JSON.stringify(value) : value;
    // The same policy rules as the console; a missing value keeps the column default.
    try { validatePolicySettings(config, agent); } catch (error) { assert(false, `Invalid policy: ${error.message}`); }
    assert(config.classic_oidc !== 'on' || config.secret_hash !== null, 'Classic OpenID Connect needs a confidential client');
    for (const key of POLICY) if (config[key] !== undefined) client[key] = typeof config[key] === 'object' ? JSON.stringify(config[key]) : config[key];
    assert(['invited','open'].includes(client.signup_policy), 'Invalid signup_policy');
    assert([0,1].includes(client.dev), 'dev must be 0 or 1');
    assert(Array.isArray(config.redirect_uris) && config.redirect_uris.length > 0, 'At least one redirect URI required');
    assert(Array.isArray(config.post_logout_uris ?? []), 'post_logout_uris must be an array');
    for (const field of ['redirect_uris','post_logout_uris']) for (const uri of JSON.parse(client[field])) registeredUri(client, uri, field);
    validateSignInSettings(methods, config.allowed_domains ?? []);
    // The same branding rules as the console.
    try { validateBranding(config.branding, { app: true }); } catch (error) { assert(false, `Invalid branding: ${error.message}`); }
    if (client.backchannel_uri !== null) registeredUri({ redirect_uris: JSON.stringify([client.backchannel_uri]), dev: 0 }, client.backchannel_uri);
    return `-- Review before applying. No upsert: an existing client requires a deliberate policy edit.\nINSERT INTO clients(${Object.keys(client).join(',')}) VALUES(${Object.values(client).map(sql).join(',')});\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        assert(process.argv.length === 3, 'Usage: node scripts/seed-client.mjs client.json > client.sql');
        process.stdout.write(clientSeedSql(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
