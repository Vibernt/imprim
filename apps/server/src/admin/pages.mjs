// The admin console, in Fire markup. Every page is server-rendered; only the Branding page loads JavaScript (Fire's
// Tweaks panel and the logo upload). Copy follows docs/fire/WRITING.md.
import { page, escapeHtml as e } from '../pages/layout.mjs';
import { heading, button, linkButton, field, hidden, callout, setting, kv, list, empty, status, code, table, actions, checkbox, dotLogo } from '../pages/ui.mjs';
import { COPY_KEYS } from '../branding/tokens.mjs';
const SECTIONS = [['clients', 'Clients'], ['services', 'Services'], ['branding', 'Branding'], ['users', 'Users'], ['audit', 'Audit log'], ['keys', 'Keys'], ['realms', 'Realms'], ['settings', 'Settings']];
const link = (url, label) => `<a class="fd-link" href="${e(url)}">${e(label)}</a>`;
const json = value => `<pre class="fd-codeblock-body fd-code">${e(JSON.stringify(value, null, 2))}</pre>`;
const when = ms => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'Never';
const cap = value => String(value ?? '').replace(/^./, c => c.toUpperCase());
const STATUS_TONE = { active: 'success', blocked: 'danger', deleted: 'neutral', disabled: 'neutral', retired: 'neutral', pending: 'warning', published: 'warning' };
// Admin pages have no script unless they ask for modules; fonts and Fire's data: images are same-origin or inline.
function adminPage(title, body, { description = '', active = '', modules = [] } = {}) {
    const nav = `<nav class="fd-chip-nav" aria-label="Admin">${SECTIONS.map(([id, label]) => `<a class="fd-chip" href="/admin/${id}"${id === active ? ' aria-current="page"' : ''}>${e(label)}</a>`).join('')}<a class="fd-chip" href="/login">Sign in again</a></nav>`;
    const response = page(title, heading(title, description) + body, { wide: true, nav, modules });
    response.headers.set('content-security-policy', `default-src 'none'; ${modules.length ? "script-src 'self'; connect-src 'self'; " : ''}style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    return response;
}
const form = (path, csrf, body, attrs = '') => `<form class="fd-stack" data-gap="4" method="post" action="${e(path)}"${attrs}>${hidden('csrf', csrf)}${body}</form>`;
const card = (body, title = '', description = '') => `<article class="fd-card"><div class="fd-stack" data-gap="4">${title ? `<div class="fd-stack" data-gap="1"><h2 class="fd-h3">${e(title)}</h2>${description ? `<p class="fd-small fd-muted">${e(description)}</p>` : ''}</div>` : ''}${body}</div></article>`;
export function clientList(rows) {
    const body = rows.length ? list('Clients', rows.map(c => ({ title: c.branding.name || c.id, desc: code(c.id), trail: linkButton('Edit', '/admin/clients/' + encodeURIComponent(c.id), { variant: 'ghost', size: 'sm' }) })))
        : empty('No clients yet', 'Register an app to let people sign in to it here.');
    return adminPage('Clients', `<div class="fd-row" data-justify="end">${linkButton('Register client', '/admin/clients/new', { variant: 'primary', icon: 'plus' })}</div>${body}`,
        { description: 'Apps that sign people in through this realm.', active: 'clients' });
}
const CLIENT_HINTS = {
    redirect_uris: 'Exact HTTPS callback URLs, as a JSON list.', post_logout_uris: 'Exact URLs to return to after sign-out.', backchannel_uri: 'Receives signed logout and revocation events. Required.',
    sign_in_methods: 'In display order: email, password, passkey, github, google or a provider id.', signup_policy: 'invited or open.', allowed_domains: 'Email domains admitted without an invitation.',
    branding: 'Overrides the realm: name, look, copy, links and logos. See Branding.', mfa: 'off, optional or required.', agent_access: 'on or off.'
};
export function clientEditor(client, csrf, isNew = false, delivery = null) {
    const value = client || { id: '', redirect_uris: [], post_logout_uris: [], backchannel_uri: '', signup_policy: 'invited',
        sign_in_methods: ['email'], google_hosted_domains: [], allowed_domains: [], branding: { name: '' }, dev: 0,
        mfa: 'off', mfa_trusted_device_days: 0, agent_consent_mfa: 'off', agent_dpop: 'optional', token_exchange_from: {}, user_events: 'off', agent_access: 'off', agent_registration_methods: ['metadata_document'], agent_allowlist: [], agent_scope_catalogue: {}, agent_resource_prefixes: [], agent_max_grant_days: 90 };
    const fields = Object.entries(value).filter(([key]) => key !== 'confidential').map(([key, v]) => {
        if (key === 'version') return hidden(key, v);
        if (key === 'id' && !isNew) return '';
        const label = key[0].toUpperCase() + key.slice(1).replaceAll('_', ' ');
        return typeof v === 'object'
            ? field({ id: `f-${key}`, label, name: key, multiline: true, mono: true, rows: 3, required: true, value: JSON.stringify(v, null, 2), hint: CLIENT_HINTS[key] })
            : field({ id: `f-${key}`, label, name: key, value: v, required: true, hint: CLIENT_HINTS[key], spellcheck: 'false' });
    }).join('');
    const path = isNew ? '/admin/clients' : '/admin/clients/' + encodeURIComponent(value.id);
    const rotate = isNew ? '' : card(form(path + '/rotate-secret', csrf, (value.confidential ? '' : checkbox('make_confidential', 'Make this public client confidential (it then authenticates at the token endpoint)', { value: 'true', required: true })) +
        `<div class="fd-row">${button('Rotate secret', { variant: 'outline', icon: 'refresh-cw' })}</div>`), 'Client secret', 'Rotating shows a new secret once and stops the old one. Needs a sign-in in the last 10 minutes.');
    const deliveryCard = delivery ? card(kv([['Undelivered', e(delivery.counts.undelivered)], ['Expired', e(delivery.counts.expired)]]) +
        (delivery.events.length ? table('Back-channel events', ['Kind', 'Event', 'State', 'Last error'], delivery.events.map(event => [e(event.kind), code(event.id), status(cap(event.delivery_state), event.delivery_state === 'expired' ? 'danger' : 'warning'), e(event.last_error || 'None')])) : ''),
        'Back-channel delivery', 'Signed events waiting for this app, retried for 24 hours.') : '';
    return adminPage(isNew ? 'Register client' : value.branding?.name || value.id, card(form(path, csrf, fields + actions(button(isNew ? 'Register client' : 'Save client', { variant: 'primary' }))), isNew ? '' : 'Settings', isNew ? '' : `Client ${value.id}`) + rotate + deliveryCard,
        { description: isNew ? 'An app that signs people in through this realm. Lists and branding are JSON.' : 'Lists and branding are JSON. Sign-in methods show in this order.', active: 'clients' });
}
export function userList(rows, search) {
    const more = rows.length > 50 ? `<div class="fd-row" data-justify="end">${linkButton('Next page', '/admin/users?' + new URLSearchParams({ q: search, before: rows[49].id }), { variant: 'ghost' })}</div>` : '';
    const searchForm = `<form class="fd-row" data-gap="2" data-align="end" method="get"><div class="fd-grow">${field({ id: 'q', label: 'Email or user ID', name: 'q', value: search, placeholder: 'dana@example.com' })}</div>${button('Search', { icon: 'search' })}</form>`;
    const body = rows.length ? table('Users', ['Email', 'Status', 'User ID'], rows.slice(0, 50).map(u => [link('/admin/users/' + encodeURIComponent(u.id), u.email), status(cap(u.status), STATUS_TONE[u.status]), code(u.id)]))
        : empty(search ? 'No users match' : 'No users yet', search ? 'Try another email or a full user ID.' : 'People appear here after their first sign-in.');
    return adminPage('Users', searchForm + body + more, { description: 'Everyone who has signed in to this realm.', active: 'users' });
}
export function userPage(user, csrf) {
    const path = '/admin/users/' + encodeURIComponent(user.id);
    const sessions = user.sessions.length ? list('Sessions', user.sessions.map(s => ({ title: s.device || s.method || 'Session', desc: code(s.sid), trail: form(path + '/revoke-session', csrf, hidden('sid', s.sid) + button('Revoke', { variant: 'ghost', size: 'sm', 'aria-label': `Revoke session ${s.sid}` })) })))
        : empty('No active sessions', 'Sessions appear while this person is signed in.');
    const lifecycle = ['block', 'unblock', 'delete'].map(action => form(path + '/' + action, csrf, button(action[0].toUpperCase() + action.slice(1), { variant: action === 'delete' ? 'danger' : 'outline', size: 'sm' }))).join('');
    return adminPage(user.email, kv([['User ID', code(user.id)], ['Status', status(cap(user.status), STATUS_TONE[user.status])]]) +
        card(sessions, 'Sessions') +
        card(`<div class="fd-row" data-gap="2" data-wrap>${lifecycle}</div>`, 'Account', 'Blocking and deleting end every session and agent grant. Needs a sign-in in the last 10 minutes.') +
        card(form(path + '/reset-mfa', csrf, field({ id: 'reason', label: 'Reason', name: 'reason', required: true, minlength: 5, maxlength: 500, placeholder: 'Lost phone, identity checked by video call', hint: 'Kept in the audit log. The person is told by email.' }) +
            `<div class="fd-row">${button('Reset two-factor', { variant: 'outline' })}</div>`), 'Two-factor', 'Removes their authenticators and passkeys, so they enrol again.') +
        card(`<form class="fd-stack" data-gap="4" method="get" action="${e(path + '/merge')}">${field({ id: 'surviving_id', label: 'Surviving user ID', name: 'surviving_id', required: true })}<div class="fd-row">${button('Review merge', { variant: 'outline' })}</div></form>`,
            'Merge into another user', 'Merge this user into another: this user is deleted, and the other keeps their ID, apps and sign-in methods.') +
        card(json(user), 'Record'), { description: 'Sessions, status and sign-in methods. App memberships stay in each app.', active: 'users' });
}
export function auditPage(rows, query) {
    const next = new URLSearchParams(query); if (rows.length > 50) next.set('before', rows[49].id);
    const filters = `<form class="fd-row" data-gap="2" data-align="end" data-wrap method="get"><div class="fd-grow">${field({ id: 'actor', label: 'Actor', name: 'actor', value: query.get('actor') || '' })}</div><div class="fd-grow">${field({ id: 'target', label: 'Target', name: 'target', value: query.get('target') || '' })}</div>${button('Filter', { icon: 'list-filter' })}</form>`;
    const body = rows.length ? table('Audit log', ['Time', 'Event', 'Actor', 'Target', 'Detail'], rows.slice(0, 50).map(r => [e(when(r.created)), code(r.event), r.actor ? code(r.actor) : 'System', r.target ? code(r.target) : 'None', code(r.detail || '{}')]))
        : empty('No events match', 'Clear the actor and target to see every event.');
    return adminPage('Audit log', filters + body + (rows.length > 50 ? `<div class="fd-row" data-justify="end">${linkButton('Next page', '/admin/audit?' + next, { variant: 'ghost' })}</div>` : ''),
        { description: 'Every sign-in, grant and admin change, newest first. Rows cannot be edited.', active: 'audit' });
}
export function keysPage(keys, csrf) {
    const rows = table('Signing keys', ['Key ID', 'Status', 'Signs from', 'Retires'], keys.map(k => [code(k.kid), status(cap(k.status), STATUS_TONE[k.status] || 'success'), e(when(k.activates_at ?? k.activated_at ?? k.created)), e(when(k.retires_at ?? k.retired_at))]));
    const revoke = keys.filter(key => key.status !== 'retired').map(key => form('/admin/keys/' + encodeURIComponent(key.kid) + '/revoke', csrf, button(`Revoke ${key.kid}`, { variant: 'danger', size: 'sm' }))).join('');
    return adminPage('Signing keys', rows +
        card(form('/admin/keys/rotate', csrf, `<div class="fd-row">${button('Rotate now', { variant: 'outline', icon: 'refresh-cw' })}</div>`), 'Rotate', 'Publishes a new key now; it signs from 1 hour later. Old public keys stay for 24 hours.') +
        card(callout('Only for a compromised key', 'The key leaves JWKS at once, a replacement signs immediately, and its tokens stop verifying within 10 minutes.', { tone: 'warning' }) + `<div class="fd-row" data-gap="2" data-wrap>${revoke}</div>`, 'Emergency revocation'),
        { description: 'ES256 keys that sign this realm’s tokens.', active: 'keys' });
}
const BRAND_FIELDS = [['name', 'Name', 'Acme', 'Shown in the header, page titles and emails.'], ['legal_name', 'Legal name', 'Acme Ltd', 'Footer and emails: © Acme Ltd.'],
    ['support_email', 'Support email', 'help@acme.com', ''], ['support_url', 'Help URL', 'https://acme.com/help', 'Used instead of the support email in the footer.'],
    ['privacy_url', 'Privacy URL', 'https://acme.com/privacy', ''], ['terms_url', 'Terms URL', 'https://acme.com/terms', ''], ['locale', 'Language', 'en-GB', 'The page language tag.']];
const COPY_LABELS = { sign_in_heading: ['Sign-in heading', 'Sign in to Acme'], sign_in_help: ['Sign-in line', 'Use your work email.'], consent_intro: ['Agent consent line', 'Agents act as you, within the scopes below.'],
    signed_out: ['Signed-out line', 'See you soon.'], footer: ['Footer line', 'Acme accounts run on Imprim.'] };
const logoSlot = (key, label, hint, id) => `<div class="fd-setting"><div class="fd-setting-text"><h3 class="fd-setting-title">${e(label)}</h3><p class="fd-setting-desc">${e(hint)}</p></div>
<div class="fd-setting-control"><div class="fd-row" data-gap="3"><span class="fd-tile" data-size="36" data-slot-preview="${key}">${id ? `<img class="x-logo" src="/assets/brand/${e(id)}" alt="">` : ''}</span>
<label class="fd-btn" data-variant="outline" data-size="sm"><span>Upload</span><input class="fd-sr-only" type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" data-slot="${key}"></label>
${button('Remove', { type: 'button', variant: 'ghost', size: 'sm', 'data-remove': key, hidden: !id })}</div></div></div>`;
export function brandingPage({ branding, version }, csrf) {
    const brandFields = BRAND_FIELDS.map(([key, label, placeholder, hint]) => field({ id: `b-${key}`, label, name: key, value: branding[key] ?? '', placeholder, hint })).join('');
    const copyFields = COPY_KEYS.map(key => field({ id: `c-${key}`, label: COPY_LABELS[key][0], name: `copy.${key}`, value: branding.copy?.[key] ?? '', placeholder: COPY_LABELS[key][1] })).join('');
    const specimen = `<article class="fd-card" aria-label="Sample sign-in"><div class="fd-stack" data-gap="4"><div class="fd-brand">${dotLogo}<span class="fd-brand-name">${e(branding.name || 'Your brand')}</span></div>
<div class="fd-stack" data-gap="1-5"><p class="fd-h2">${e(branding.copy?.sign_in_heading || `Sign in to ${branding.name || 'your brand'}`)}</p><p class="fd-muted">${e(branding.copy?.sign_in_help || 'Use the email your team invited.')}</p></div>
<div class="fd-field"><span class="fd-field-label">Email</span><span class="fd-input" data-size="lg">dana@example.com</span></div>${button('Email me a link', { type: 'button', variant: 'primary', size: 'lg', block: true })}${button('Sign in with a passkey', { type: 'button', variant: 'outline', size: 'lg', block: true })}</div></article>`;
    const body = `<div id="branding-editor" class="fd-stack" data-gap="6" data-csrf="${e(csrf)}" data-version="${e(version)}" data-branding="${e(JSON.stringify(branding))}">
<div class="fd-callout" role="alert" data-tone="danger" id="branding-error" hidden><div class="fd-callout-content"><p class="fd-callout-title">Not saved</p><p class="fd-callout-body" id="branding-error-text"></p></div></div>
<div class="fd-grid" data-min="lg" data-cols="2" data-gap="6"><div class="fd-stack" data-gap="6">
${card(`<p class="fd-small fd-muted">Palette, tone, type, density, corners, contrast and motion. This page changes as you go; nothing is live until you save.</p><div class="fd-row" data-gap="3" data-wrap>${button('Open tweaks', { type: 'button', variant: 'outline', icon: 'sliders-horizontal', 'data-fd-tweaks-open': true, 'aria-expanded': 'false' })}<code class="fd-code" id="look-summary">${e(JSON.stringify(branding.look || {}))}</code></div>`, 'Look', 'Fire keeps text and buttons readable in every palette and tone.')}
${card(logoSlot('logo_light', 'Logo', 'Replaces the IMPRIM logo and the name in the header. SVG, PNG, JPEG or WebP, up to 256 KiB.', branding.logo_light) + logoSlot('logo_dark', 'Dark-mode logo', 'Used when the page is dark. Optional.', branding.logo_dark) + logoSlot('mark', 'Mark', 'A square icon for the browser tab, shown beside the name when there is no logo.', branding.mark), 'Logo', 'With no logo, pages show the IMPRIM dot logo and the name.')}
${card(brandFields, 'Name and links')}
${card(copyFields, 'Words', 'Leave a field empty to use the default. Plain text, up to 300 characters.')}
</div><div class="fd-stack" data-gap="3"><p class="fd-eyebrow">Preview</p>${specimen}<p class="fd-small fd-muted">${link('/admin/branding/preview', 'Open the sign-in page')} to see it with your apps’ methods.</p></div></div>
<div class="fd-form-actions">${button('Discard changes', { type: 'button', variant: 'ghost', id: 'branding-reset' })}${button('Save branding', { type: 'button', variant: 'primary', id: 'branding-save' })}</div></div>`;
    return adminPage('Branding', body, { description: 'How sign-in, consent and account pages look for this realm. Apps can override it.', active: 'branding', modules: ['/imprim/branding-editor.js'] });
}
export const servicesPage = rows => adminPage('Service clients', rows.length ? table('Service clients', ['Name', 'Client ID', 'App', 'Scopes', 'Owner', 'Status'], rows.map(s => [e(s.name), code(s.id), code(s.app_id), e((s.scopes || []).join(' ')), e(s.owner_email), status(cap(s.status), STATUS_TONE[s.status] || 'success')]))
    : empty('No service clients yet', 'Create one with POST /admin/api/services and its public key.'), { description: 'Machines acting as themselves for one app, with client credentials and a signed key.', active: 'services' });
export function realmsPage(realms, csrf) {
    const rows = table('Realms', ['Realm', 'Issuer', 'Status', 'Admins'], realms.map(r => [`${e(r.display_name)} ${code(r.id)}`, code(r.issuer || 'Not set'), status(cap(r.status), STATUS_TONE[r.status]), e(r.admins.map(a => `${a.email} (${a.role})`).join(', ') || 'None')]));
    const create = card(form('/admin/realms', csrf, `<div class="fd-grid" data-min="md" data-cols="3" data-gap="4">${field({ id: 'r-id', label: 'Realm ID', name: 'id', required: true, placeholder: 'acme' })}${field({ id: 'r-issuer', label: 'Issuer', name: 'issuer', required: true, placeholder: 'https://id.acme.com' })}${field({ id: 'r-name', label: 'Display name', name: 'display_name', required: true, placeholder: 'Acme' })}</div>` +
        field({ id: 'r-config', label: 'Config', name: 'config', multiline: true, mono: true, rows: 8, required: true, value: '{}', hint: 'Secrets are never stored here: name a Worker secret as {"env":"NAME"}.' }) + `<div class="fd-row">${button('Create realm', { variant: 'primary' })}</div>`),
        'New realm', 'Its host must also be added as a custom domain on this Worker.');
    return adminPage('Realms', rows + create + card(json(realms), 'Config'), { description: 'Brands on this deployment. Platform administrators only.', active: 'realms' });
}
export const settingsPage = settings => adminPage('Settings', card(json(settings)), { description: 'Deployment configuration, read only. Change it with a reviewed deployment.', active: 'settings' });
export function resultPage(result) {
    return adminPage('Done', (result.client_secret ? callout('Copy the new client secret now', 'It is shown once. Store it in your app’s secrets before you leave this page.', { tone: 'warning' }) : '') + card(json(result)) +
        `<div class="fd-row">${linkButton('Back to the console', '/admin', { variant: 'outline' })}</div>`, { description: 'The change is saved.' });
}
export function mergeConfirmation(source, survivor, csrf) {
    return adminPage(`Merge ${source.email}?`, kv([['Deleted', `${e(source.email)} ${code(source.id)}`], ['Kept', `${e(survivor.email)} ${code(survivor.id)}`]]) +
        callout('This can’t be undone', 'The deleted user’s sessions and agent grants end, and their sign-in methods move to the kept user.', { tone: 'danger' }) +
        card(form('/admin/users/' + encodeURIComponent(source.id) + '/merge', csrf,
            hidden('surviving_id', survivor.id) + field({ id: 'confirm_source_email', label: 'Type the deleted user’s email', name: 'confirm_source_email', required: true, autocomplete: 'off' }) +
            actions(linkButton('Cancel', '/admin/users/' + encodeURIComponent(source.id), { variant: 'ghost' }), button('Merge users', { variant: 'danger' })))),
        { description: 'Check both accounts before you merge.', active: 'users' });
}
