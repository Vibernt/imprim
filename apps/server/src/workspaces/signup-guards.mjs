import { enabledSignupModeSql, signupModeIsSql, signupOff, signupSettingsSql } from '../auth/signup-policy.mjs';
import { msg } from '../i18n/index.mjs';
import { realmId } from '../realms/realm.mjs';
import { appPolicySql, domainOf } from '../services/admission.mjs';
import { openWorkspaceInvitationSql, reachesProductSql } from './access.mjs';

export const signupGuard = (sql, args, code, message, status = 409) => ({ sql, args, code, message, status });

export function signupSettingsGuard(env, client, mode) {
    return signupGuard(`EXISTS(SELECT 1 FROM clients c WHERE c.realm_id=? AND c.id=? AND c.product=?
        AND ${signupSettingsSql} AND ${mode ? signupModeIsSql : enabledSignupModeSql})`,
    [realmId(env), client.id, client.product, ...(mode ? [mode] : [])], 'access_denied', signupOff, 403);
}

// Browser-driven sign-up has a pending authorization request and browser binding.
export function signupBrowserChecks(env, { client, row }, email, now) {
    return [
        signupGuard(`EXISTS(SELECT 1 FROM auth_requests a JOIN clients c ON c.id=a.client_id
            WHERE c.realm_id=? AND a.id=? AND a.client_id=? AND a.browser_hash=? AND a.redirect_uri=? AND a.expires_at>?
            AND a.agent_client_id IS NULL
            AND EXISTS(SELECT 1 FROM json_each(c.redirect_uris) WHERE value=a.redirect_uri))`,
        [realmId(env), row.id, client.id, row.browser_hash, row.redirect_uri, now],
        'browser_binding', msg('Sign-in must finish in the browser that started it.'), 403),
        signupGuard(`NOT EXISTS(SELECT 1 FROM auth_requests a WHERE a.id=? AND a.hint_sub IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM users u WHERE u.id=a.hint_sub AND u.realm_id=? AND u.email=?))`,
        [row.id, realmId(env), email], 'login_required', msg('This app asked for a different account. Sign in as that person.'), 401),
        signupGuard(`NOT EXISTS(SELECT 1 FROM auth_requests a WHERE a.id=? AND NOT EXISTS(
            SELECT 1 FROM users u WHERE u.realm_id=? AND u.email=?
            AND (a.workspace_join IS NULL OR json_extract(a.workspace_join,'$.user_id')=u.id)
            AND (a.workspace_access IS NULL OR json_extract(a.workspace_access,'$.user_id')=u.id))
            AND (a.workspace_join IS NOT NULL OR a.workspace_access IS NOT NULL))`,
        [row.id, realmId(env), email], 'access_denied', msg('This sign-in request belongs to another account.'), 403)
    ];
}

export function signupOwnershipGuard(env, client, email) {
    // Count existing ownership even when a sign-up workspace was closed.
    return signupGuard(`NOT EXISTS(SELECT 1 FROM users u JOIN workspace_members m ON m.user_id=u.id
        JOIN workspaces w ON w.id=m.workspace_id JOIN workspace_products p ON p.workspace_id=w.id
        WHERE u.realm_id=? AND u.email=? AND w.realm_id=u.realm_id AND m.role='owner'
        AND w.created_via='signup' AND p.product=?)`,
    [realmId(env), email, client.product], 'signup_limit', msg('You already own a workspace created through sign-up for this product.'));
}

export function signupAccessGuard(env, client, email, now) {
    return signupGuard(`NOT EXISTS(SELECT 1 FROM clients c WHERE c.id=? AND c.realm_id=? AND (
        EXISTS(SELECT 1 FROM client_admissions a JOIN users u ON u.id=a.user_id
            WHERE a.client_id=c.id AND a.source='app' AND u.realm_id=c.realm_id AND u.email=?)
        OR ${appPolicySql('?')} OR ${reachesProductSql('c.realm_id', 'c.product',
            '(SELECT id FROM users WHERE realm_id=c.realm_id AND email=?)')} OR ${openWorkspaceInvitationSql}))`,
    [client.id, realmId(env), email, 'mailbox', domainOf(email), 'mailbox', email, now, email, email, now],
    'conflict', msg('Access changed. Request a new email link.'));
}

export function signupProviderMethodGuard(env, client, provider, hostedDomain) {
    // An email link carries proof of the mailbox. Only a direct Google callback has a current hosted-domain claim.
    const checkDomain = provider === 'google' && hostedDomain !== undefined;
    return signupGuard(`EXISTS(SELECT 1 FROM clients c WHERE c.realm_id=? AND c.id=?
        AND EXISTS(SELECT 1 FROM json_each(c.sign_in_methods) WHERE value=?)
        ${checkDomain ? `AND (json_array_length(c.google_hosted_domains)=0
            OR EXISTS(SELECT 1 FROM json_each(c.google_hosted_domains) WHERE value=?))` : ''})`,
    [realmId(env), client.id, provider, ...(checkDomain ? [hostedDomain] : [])], 'access_denied',
    msg('Sign-in method or hosted domain is not allowed for this app.'), 403);
}

export function signupProviderAccountGuard(env, email) {
    return signupGuard('NOT EXISTS(SELECT 1 FROM admins WHERE realm_id=? AND email=?)',
        [realmId(env), email], 'access_denied', 'Account unavailable.', 403);
}
