// The form that registers or edits a client. Every setting has the control that fits its value (a list, a switch, a
// choice, a number with its unit), laid out as Fire's long form: one section per concern (docs/fire/GUIDE.md section 5,
// "Forms"). admin/client-form.mjs reads what it posts. Copy follows docs/fire/WRITING.md.
import { escapeHtml as e } from '../pages/layout.mjs';
import { hidden, button, linkButton, actions } from '../pages/ui.mjs';
import { text, shown, list, pairs, json, choice, checks, toggle, amount, cols, formSection, advanced } from '../pages/forms.mjs';
import { SWITCHES } from './client-form.mjs';
const NEW = { id: '', redirect_uris: [], post_logout_uris: [], backchannel_uri: '', signup_policy: 'invited', sign_in_methods: ['email'], google_hosted_domains: [],
    allowed_domains: [], branding: { name: '' }, dev: 0, mfa: 'off', mfa_trusted_device_days: 0, agent_consent_mfa: 'off', agent_dpop: 'optional', classic_oidc: 'off', id_token_signed_response_alg: 'ES256', token_exchange_from: {},
    user_events: 'off', agent_access: 'off', agent_registration_methods: ['metadata_document'], agent_allowlist: [], agent_scope_catalogue: {}, agent_resource_prefixes: [], agent_max_grant_days: 90 };
export const METHODS = { email: 'Email link', password: 'Password', passkey: 'Passkey', github: 'GitHub', google: 'Google' };
const HOST = '^[a-z0-9-]+(\\.[a-z0-9-]+)+$';
// The saved choices first, in their saved order, then the rest: the order of the boxes is the order that is saved.
const ordered = (saved, known) => [...saved.map(value => [value, known[value] || value]), ...Object.entries(known).filter(([value]) => !saved.includes(value))];
const on = (value, name) => String(value[name]) === SWITCHES[name][0];
// client: the saved client, or null for a new one. providers: this realm's upstream providers, id to name.
// Returns the form's markup; the page around it is admin/pages.mjs.
export function clientForm(client, csrf, { providers = {} } = {}) {
    const value = client || NEW, isNew = !client;
    const path = isNew ? '/admin/clients' : `/admin/clients/${encodeURIComponent(value.id)}`;
    const app = formSection('app', 'App', 'How this app is known here.', isNew
        ? text({ id: 'f-id', label: 'Client ID', name: 'id', value: value.id, required: true, mono: true, pattern: '[A-Za-z0-9_-]{1,200}', placeholder: 'notes', hint: 'Letters, numbers, dashes and underscores. It can’t change later.' })
        : shown({ label: 'Client ID', value: value.id, mono: true }));
    const callbacks = formSection('callbacks', 'Callbacks', 'Where this app receives people and events.',
        list({ id: 'f-redirect_uris', label: 'Redirect URLs', name: 'redirect_uris', values: value.redirect_uris, required: true, rows: 3, pattern: '^https?://', placeholder: 'https://notes.example/callback', hint: 'Exact URLs. People return here after signing in.' }) +
        list({ id: 'f-post_logout_uris', label: 'Sign-out URLs', name: 'post_logout_uris', values: value.post_logout_uris, pattern: '^https?://', placeholder: 'https://notes.example/signed-out', hint: 'Where people may land after signing out.' }) +
        text({ id: 'f-backchannel_uri', label: 'Back-channel URL', name: 'backchannel_uri', value: value.backchannel_uri ?? '', required: true, mono: true, type: 'url', placeholder: 'https://notes.example/backchannel', hint: 'Receives signed sign-out and revocation events.' }) +
        toggle({ id: 'f-dev', label: 'Development mode', desc: 'Allows http://localhost callbacks. Turn it off in production.', name: 'dev', on: SWITCHES.dev[0], checked: on(value, 'dev') }));
    const signIn = formSection('sign-in', 'Sign-in', 'How people get in, and who may.',
        checks({ id: 'f-sign_in_methods', label: 'Methods', name: 'sign_in_methods', options: ordered(value.sign_in_methods, { ...METHODS, ...providers }), chosen: value.sign_in_methods, hint: 'The sign-in page shows them in this order. A method you turn on goes last.' }) +
        choice({ id: 'f-signup_policy', label: 'Who can sign up', name: 'signup_policy', value: value.signup_policy, options: [['invited', 'Invited only'], ['open', 'Anyone']] }) +
        list({ id: 'f-allowed_domains', label: 'Allowed email domains', name: 'allowed_domains', values: value.allowed_domains, pattern: HOST, placeholder: 'example.com', hint: 'People with these domains join without an invitation.' }) +
        list({ id: 'f-google_hosted_domains', label: 'Google Workspace domains', name: 'google_hosted_domains', values: value.google_hosted_domains, pattern: HOST, placeholder: 'example.com', hint: 'Only these Workspace domains may sign in with Google. Leave empty to allow any Google account.' }) +
        cols(choice({ id: 'f-mfa', label: 'Two-factor', name: 'mfa', value: value.mfa, options: [['off', 'Off'], ['optional', 'Optional'], ['required', 'Required']] }),
            amount({ id: 'f-mfa_trusted_device_days', label: 'Remember browsers for', name: 'mfa_trusted_device_days', value: value.mfa_trusted_device_days, unit: 'days', min: 0, max: 90, hint: '0 asks every time.' })) +
        toggle({ id: 'f-classic_oidc', label: 'Classic OpenID Connect', desc: 'Lets this app leave out PKCE and the nonce, as OpenID Connect libraries written before OAuth 2.1 do. Keep it off unless the app’s library needs it.', name: 'classic_oidc', on: SWITCHES.classic_oidc[0], checked: on(value, 'classic_oidc') }) +
        choice({ id: 'f-id_token_signed_response_alg', label: 'ID token signature', name: 'id_token_signed_response_alg', value: value.id_token_signed_response_alg ?? 'ES256', options: [['ES256', 'ES256 (recommended)'], ['RS256', 'RS256, for libraries that need it']] }));
    const agents = formSection('agents', 'Agents', 'AI agents acting for a person in this app.',
        toggle({ id: 'f-agent_access', label: 'Agent access', desc: 'Turning it off revokes every agent grant for this app.', name: 'agent_access', on: SWITCHES.agent_access[0], checked: on(value, 'agent_access') }) +
        checks({ id: 'f-agent_registration_methods', label: 'How agents register', name: 'agent_registration_methods', options: ordered(value.agent_registration_methods, { metadata_document: 'Metadata document', dynamic: 'Dynamic registration' }),
            chosen: value.agent_registration_methods, hint: 'Dynamic registration lets an agent register itself, so its name is not verified.' }) +
        pairs({ id: 'f-agent_scope_catalogue', label: 'Scopes', name: 'agent_scope_catalogue', entries: Object.entries(value.agent_scope_catalogue), keyLabel: 'Scope', valueLabel: 'What people see at consent',
            keyPlaceholder: 'notes:read', valuePlaceholder: 'Read your notes', addLabel: 'Add scope' }) +
        list({ id: 'f-agent_resource_prefixes', label: 'Resources', name: 'agent_resource_prefixes', values: value.agent_resource_prefixes, pattern: '^https://', placeholder: 'https://notes.example/w/', hint: 'Agents may ask for URLs that start with one of these.' }) +
        list({ id: 'f-agent_allowlist', label: 'Allowed agents', name: 'agent_allowlist', values: value.agent_allowlist, placeholder: 'agent.example.com', hint: 'An agent’s host or its full client URL. Leave empty to allow any agent.' }) +
        amount({ id: 'f-agent_max_grant_days', label: 'Longest grant', name: 'agent_max_grant_days', value: value.agent_max_grant_days, unit: 'days', min: 1, hint: 'People approve again after this long.' }) +
        toggle({ id: 'f-agent_consent_mfa', label: 'Second factor at consent', desc: 'Ask for a code or a passkey before a person approves an agent.', name: 'agent_consent_mfa', on: SWITCHES.agent_consent_mfa[0], checked: on(value, 'agent_consent_mfa') }) +
        toggle({ id: 'f-agent_dpop', label: 'Require key-bound tokens', desc: 'Agents must prove a key with every request (DPoP), so a stolen token is useless.', name: 'agent_dpop', on: SWITCHES.agent_dpop[0], checked: on(value, 'agent_dpop') }));
    const machines = formSection('machines', 'Machines and events', 'Services calling each other, and events about people.',
        pairs({ id: 'f-token_exchange_from', label: 'Token exchange', name: 'token_exchange_from', entries: Object.entries(value.token_exchange_from).map(([id, scopes]) => [id, scopes.join(' ')]), keyLabel: 'App',
            valueLabel: 'Scopes it may ask for', keyPlaceholder: 'reports', valuePlaceholder: 'notes:read notes:write', addLabel: 'Add app', hint: 'Apps that may swap a token they hold for one aimed at this app. Put a space between scopes.' }) +
        toggle({ id: 'f-user_events', label: 'User events', desc: 'Send this app a signed event when a person’s profile changes or they are deleted.', name: 'user_events', on: SWITCHES.user_events[0], checked: on(value, 'user_events') }));
    const more = formSection('advanced', 'Advanced', 'Overrides for this app only.', advanced('Override branding',
        json({ id: 'f-branding', label: 'Branding', name: 'branding', value: value.branding, hint: 'Overrides the realm’s name, look, words, links and logos for this app. The Branding page lists the fields.' })));
    return `<form class="fd-form" data-size="full" method="post" action="${e(path)}" data-fd-validate autocomplete="off">${hidden('csrf', csrf)}${hidden('editor', '1')}${value.version === undefined ? '' : hidden('version', value.version)}
${app}${callbacks}${signIn}${agents}${machines}${more}
${actions(linkButton('Cancel', '/admin/clients', { variant: 'ghost' }), button(isNew ? 'Register client' : 'Save client', { variant: 'primary' }))}</form>`;
}
