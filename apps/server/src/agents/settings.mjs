import { invariant } from '../lib/errors.mjs';
import { resourceUrl, underPrefix } from './uris.mjs';
export const settingNames = ['agent_access', 'agent_registration_methods', 'agent_allowlist', 'agent_scope_catalogue', 'agent_resource_prefixes',
    'agent_workspace_resources', 'agent_max_grant_days'];
export function validateAgentSettings(config) {
    const value = { agent_access: 'off', agent_registration_methods: ['metadata_document'], agent_allowlist: [],
        agent_scope_catalogue: {}, agent_resource_prefixes: [], agent_workspace_resources: [], agent_max_grant_days: 90, ...config };
    const check = (ok, message) => invariant(ok, 'agent_config', message);
    check(['off', 'on'].includes(value.agent_access), 'Invalid agent_access.');
    const list = (items, max) => Array.isArray(items) && items.length <= max && new Set(items).size === items.length;
    check(list(value.agent_registration_methods, 2) && value.agent_registration_methods.length > 0 && value.agent_registration_methods.every(x => ['metadata_document','dynamic'].includes(x)), 'Invalid registration methods.');
    check(list(value.agent_allowlist, 100), 'Invalid agent allowlist.');
    for (const item of value.agent_allowlist) {
        check(typeof item === 'string' && !/[\s*\\]/.test(item), 'Invalid allowlist entry.');
        const url = new URL(item.startsWith('https://') ? item : `https://${item}`);
        check(url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
            (item.startsWith('https://') ? url.href === item : url.host === item && !url.port), 'Allowlist entries must be exact HTTPS URLs or hosts.');
    }
    const catalogue = value.agent_scope_catalogue;
    check(catalogue && typeof catalogue === 'object' && !Array.isArray(catalogue) && Object.keys(catalogue).length <= 100, 'Invalid scope catalogue.');
    check(Object.entries(catalogue).every(([scope, label]) => /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(scope) && typeof label === 'string' && label.length > 0 && label.length <= 500), 'Invalid scope or description.');
    check(list(value.agent_resource_prefixes, 100), 'Invalid resource prefixes.');
    value.agent_resource_prefixes.forEach(prefix => resourceUrl(prefix, 'prefix'));
    check(list(value.agent_workspace_resources, 5), 'Enter up to five distinct workspace-choice resource URLs.');
    for (const resource of value.agent_workspace_resources) {
        resourceUrl(resource);
        check(value.agent_resource_prefixes.some(prefix => underPrefix(resource, prefix)), 'Each workspace-choice resource must be under an app resource prefix.');
    }
    check(Number.isSafeInteger(value.agent_max_grant_days) && value.agent_max_grant_days >= 1 && Number.isSafeInteger(Date.now() + value.agent_max_grant_days * 86400000), 'Grant cap must be a positive whole number of days within the timestamp range.');
    check(value.agent_access === 'off' || (Object.keys(catalogue).length > 0 && value.agent_resource_prefixes.length > 0), 'Enabled agent access needs scopes and resources.');
    return Object.fromEntries(settingNames.map(key => [key, value[key]]));
}
export function agentSettings(client) {
    return validateAgentSettings(Object.fromEntries(settingNames.map(key => [key,
        ['agent_access','agent_max_grant_days'].includes(key) ? client[key] : JSON.parse(client[key])])));
}
