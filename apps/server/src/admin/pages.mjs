import { page, escapeHtml as e } from '../pages/layout.mjs';
const hidden = (name, value) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
const link = (url, label) => `<a href="${e(url)}">${e(label)}</a>`;
const data = value => `<pre>${e(JSON.stringify(value, null, 2))}</pre>`;
export function adminPage(title, body) {
    const response = page(title, `<nav>${['clients','services','users','audit','keys','realms','settings'].map(name => link('/admin/' + name, name)).join(' · ')} · ${link('/login', 'Reauthenticate')}</nav><h1>${e(title)}</h1>${body}`);
    response.headers.set('content-security-policy', "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return response;
}
const form = (path, csrf, body) => `<form method="post" action="${e(path)}">${hidden('csrf', csrf)}${body}</form>`;
export function clientList(rows) {
    return adminPage('Clients', link('/admin/clients/new', 'Register client') + rows.map(c => `<p>${link('/admin/clients/' + encodeURIComponent(c.id), c.branding.name || c.id)}</p>`).join(''));
}
export function clientEditor(client, csrf, isNew = false, delivery = null) {
    const value = client || { id: '', redirect_uris: [], post_logout_uris: [], backchannel_uri: '', signup_policy: 'invited',
        sign_in_methods: ['email'], google_hosted_domains: [], allowed_domains: [], branding: { name: '' }, dev: 0,
        mfa: 'off', mfa_trusted_device_days: 0, agent_consent_mfa: 'off', agent_dpop: 'optional', token_exchange_from: {}, user_events: 'off', agent_access: 'off', agent_registration_methods: ['metadata_document'], agent_allowlist: [], agent_scope_catalogue: {}, agent_resource_prefixes: [], agent_max_grant_days: 90 };
    const fields = Object.entries(value).filter(([key]) => key !== 'confidential').map(([key, v]) => {
        if (key === 'version') return hidden(key, v);
        if (key === 'id' && !isNew) return `<p>Client: ${e(v)}</p>`;
        const label = key.replaceAll('_',' ');
        return `<label>${e(label)}${typeof v === 'object'
            ? `<textarea name="${e(key)}" rows="3" cols="45" required>${e(JSON.stringify(v, null, 2))}</textarea>`
            : `<input name="${e(key)}" value="${e(v)}" required>`}</label>`;
    }).join('');
    const path = isNew ? '/admin/clients' : '/admin/clients/' + encodeURIComponent(value.id);
    return adminPage(isNew ? 'Register client' : 'Edit client', `<p>Lists and branding use JSON. Sign-in methods are ordered. Back-channel URI is required.</p>` +
        form(path, csrf, fields + '<button>Save client</button>') + (isNew ? '' : form(path + '/rotate-secret', csrf, '<p>Secret rotation requires a sign-in within ten minutes.</p>' + (value.confidential ? '' : '<label><input type="checkbox" name="make_confidential" value="true" required>Make this public client confidential (changes token authentication)</label>') + '<button>Rotate secret</button>')) +
        (delivery ? `<h2>Back-channel delivery</h2><p>Undelivered: ${e(delivery.counts.undelivered)} · Expired: ${e(delivery.counts.expired)}</p>` +
            delivery.events.map(event => `<p>${e(event.kind)} ${e(event.id)} · ${e(event.delivery_state)} · ${e(event.last_error || 'No error recorded')}</p>`).join('') : ''));
}
export function userList(rows, search) {
    const more = rows.length > 50 ? link('/admin/users?' + new URLSearchParams({ q: search, before: rows[49].id }), 'Next page') : '';
    return adminPage('Users', `<form method="get"><label>Email or id<input name="q" value="${e(search)}"></label><button>Search</button></form>` +
        rows.slice(0,50).map(u => `<p>${link('/admin/users/' + encodeURIComponent(u.id), u.email)} — ${e(u.status)}</p>`).join('') + more);
}
export function userPage(user, csrf) {
    const path = '/admin/users/' + encodeURIComponent(user.id);
    return adminPage(user.email, data(user) + '<p>Actions require a sign-in within ten minutes. Merge keeps the surviving id and ends both users’ sessions and grants. App memberships are managed in each app.</p>' +
        user.sessions.map(session => form(path + '/revoke-session', csrf, `<input type="hidden" name="sid" value="${e(session.sid)}"><button>Revoke session ${e(session.sid)}</button>`)).join('') +
        ['block','unblock','delete'].map(action => form(path + '/' + action, csrf, `<button>${e(action)}</button>`)).join('') +
        form(path + '/reset-mfa', csrf, '<label>Reason for resetting two-factor<input name="reason" required minlength="5" maxlength="500"></label><button>Reset two-factor</button>') +
        `<form method="get" action="${e(path + '/merge')}"><p>Merge this user into another: this user is deleted</p><label>Surviving user id<input name="surviving_id" required></label><button>Review merge</button></form>`);
}
export function auditPage(rows, query) {
    const next = new URLSearchParams(query); if (rows.length > 50) next.set('before', rows[49].id);
    return adminPage('Audit log', `<form method="get"><label>Actor<input name="actor" value="${e(query.get('actor') || '')}"></label><label>Target<input name="target" value="${e(query.get('target') || '')}"></label><button>Filter</button></form>` +
        rows.slice(0,50).map(row => data(row)).join('') + (rows.length > 50 ? link('/admin/audit?' + next, 'Next page') : ''));
}
export function keysPage(keys, csrf) {
    return adminPage('Signing keys', data(keys) + '<p>Rotate now publishes a new key immediately. Signing starts one hour later. Previous public keys remain for 24 hours after replacement.</p>' + form('/admin/keys/rotate', csrf, '<button>Rotate now</button>') +
        '<h2>Emergency revocation</h2><p>Use only for a compromised key. It leaves JWKS at once, a replacement signs immediately, and every token it signed stops verifying when apps refetch (within 10 minutes).</p>' +
        keys.filter(key => key.status !== 'retired').map(key => form('/admin/keys/' + encodeURIComponent(key.kid) + '/revoke', csrf, `<button>Revoke ${e(key.kid)} now</button>`)).join(''));
}
export const servicesPage = rows => adminPage('Service clients', '<p>Machines acting as themselves for one app (OAuth client_credentials with private_key_jwt). Manage them with POST /admin/api/services.</p>' + data(rows));
export function realmsPage(realms, csrf) {
    return adminPage('Realms', data(realms) + '<p>Platform administrators only. Secrets are never stored here: secret fields name a Worker secret as {"env":"NAME"}. A new realm needs its host added as a custom domain on this Worker.</p>' +
        form('/admin/realms', csrf, '<label>id<input name="id" required></label><label>issuer<input name="issuer" required placeholder="https://id.example.com"></label><label>display name<input name="display_name" required></label><label>config<textarea name="config" rows="8" cols="45" required>{}</textarea></label><button>Create realm</button>'));
}
export const settingsPage = settings => adminPage('Settings', '<p>Read-only deployment configuration. Changes require a reviewed deployment.</p>' + data(settings));
export function resultPage(result) {
    return adminPage('Action completed', (result.client_secret ? '<p>Copy the new client secret now. It will not be displayed again.</p>' : '') + data(result) + link('/admin', 'Return to console'));
}

export function mergeConfirmation(source, survivor, csrf) {
    return adminPage('Confirm merge', `<p>Delete source: ${e(source.email)} (${e(source.id)})</p><p>Keep survivor: ${e(survivor.email)} (${e(survivor.id)})</p>` +
        form('/admin/users/' + encodeURIComponent(source.id) + '/merge', csrf,
            hidden('surviving_id', survivor.id) + '<label>Retype the source email to confirm deletion<input name="confirm_source_email" required autocomplete="off"></label><button>Merge this user into another: this user is deleted</button>'));
}
