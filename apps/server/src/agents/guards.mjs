// SQL predicates fence policy/user changes between network validation and atomic credential issuance.
import { settingNames } from './settings.mjs';
const fields = [...settingNames, 'sign_in_methods', 'google_hosted_domains', 'signup_policy', 'allowed_domains', 'mfa', 'mfa_trusted_device_days', 'agent_consent_mfa'];
export function policyGuard(app, resource) {
    return { sql: `EXISTS(SELECT 1 FROM clients policy WHERE policy.id=? AND ${fields.map(key => `policy.${key}=?`).join(' AND ')})
        AND NOT EXISTS(SELECT 1 FROM clients competing,json_each(competing.agent_resource_prefixes) prefix
            WHERE competing.id<>? AND (prefix.value=? OR
                substr(?,1,length(prefix.value)+CASE WHEN substr(prefix.value,-1)='/' THEN 0 ELSE 1 END)=
                prefix.value||CASE WHEN substr(prefix.value,-1)='/' THEN '' ELSE '/' END))`,
        args: [app.id, ...fields.map(key => app[key]), app.id, resource, resource] };
}
export function liveGrantGuard(grant, app, now) {
    const policy = policyGuard(app, grant.resource);
    return { sql: `EXISTS(SELECT 1 FROM agent_grants live JOIN users person ON person.id=live.user_id
        WHERE live.id=? AND live.revoked_at IS NULL AND live.expires_at>? AND person.status='active' AND person.merged_into IS NULL) AND ?>? AND ${policy.sql}`,
        args: [grant.id, now, grant.expires_at, now, ...policy.args] };
}
