import { html } from 'lit';
import { text, shown, list, pairs, jsonField, choice, checks, toggle, amount, formSection, advanced } from '../core-fields';
import { METHODS, SWITCHES, exchangePairs, type ClientFields } from './model';

const HOST = '^[a-z0-9-]+(\\.[a-z0-9-]+)+$';
const ordered = (saved: string[], known: Record<string, string>): [string, string][] => [
  ...saved.map((value): [string, string] => [value, Object.hasOwn(known, value) ? known[value] : value]),
  ...Object.entries(known).filter(([value]) => !saved.includes(value)),
];
const on = (value: ClientFields, name: keyof typeof SWITCHES) => String(value[name]) === SWITCHES[name][0];

function workspaceFields(value: ClientFields) {
  const workspaceToggle = (name: 'personal_workspaces' | 'workspace_admin', label: string, desc: string) =>
    toggle({ id: 'f-' + name, name, label, desc, on: 'on', checked: value[name] === 'on' });
  return html`
    <div class="fd-stack" data-gap="3" role="group" aria-labelledby="workspaces-title">
      <h3 class="fd-title" id="workspaces-title">Workspaces</h3>
      ${choice({ id: 'f-workspaces', label: 'Where workspaces are managed', name: 'workspaces', value: value.workspaces,
        options: [['app', 'In this app'], ['shared', 'Shared through Imprim']] })}
      ${text({ id: 'f-product', label: 'Product', name: 'product', value: value.product, mono: true, maxlength: 40,
        pattern: '[a-z][a-z0-9\\-]{1,39}', placeholder: 'notes', hint: 'Required for shared workspaces.' })}
      ${workspaceToggle('personal_workspaces', 'Personal workspaces', 'Let people create a personal workspace in this app. Requires shared workspaces.')}
      ${workspaceToggle('workspace_admin', 'Workspace administration', 'Let this app create team workspaces and manage their products. Requires shared workspaces.')}
      ${text({ id: 'f-initiate_login_uri', label: 'Invitation sign-in URL', name: 'initiate_login_uri', value: value.initiate_login_uri,
        mono: true, type: 'url', placeholder: 'https://notes.example/sign-in', hint: 'Use HTTPS on the same origin as a redirect URL.' })}
    </div>`;
}

export function clientSections(value: ClientFields, isNew: boolean, providers: Record<string, string>) {
  const app = formSection('app', 'App', 'How this app is known here.', (isNew
      ? text({ id: 'f-id', label: 'Client ID', name: 'id', value: value.id, required: true, mono: true, pattern: '[A-Za-z0-9_\\-]{1,200}', placeholder: 'notes', hint: 'Letters, numbers, dashes and underscores. It can’t change later.' })
      : shown('Client ID', value.id)), workspaceFields(value));
  const callbacks = formSection('callbacks', 'Callbacks', 'Where this app receives people and events.',
      list({ id: 'f-redirect_uris', label: 'Redirect URLs', name: 'redirect_uris', values: value.redirect_uris, required: true, rows: 3, pattern: '^https?://', placeholder: 'https://notes.example/callback', hint: 'Exact URLs. People return here after signing in.' }),
      list({ id: 'f-post_logout_uris', label: 'Sign-out URLs', name: 'post_logout_uris', values: value.post_logout_uris, pattern: '^https?://', placeholder: 'https://notes.example/signed-out', hint: 'Where people may land after signing out.' }),
      text({ id: 'f-backchannel_uri', label: 'Back-channel URL', name: 'backchannel_uri', value: value.backchannel_uri ?? '', required: true, mono: true, type: 'url', placeholder: 'https://notes.example/backchannel', hint: 'Receives signed sign-out and revocation events.' }),
      toggle({ id: 'f-dev', label: 'Development mode', desc: 'Allows http://localhost callbacks. Turn it off in production.', name: 'dev', on: SWITCHES.dev[0], checked: on(value, 'dev') }));
  const signIn = formSection('sign-in', 'Sign-in', 'How people get in, and who may.',
      checks({ id: 'f-sign_in_methods', label: 'Methods', name: 'sign_in_methods', options: ordered(value.sign_in_methods, { ...METHODS, ...providers }), chosen: value.sign_in_methods, hint: 'The sign-in page shows them in this order. A method you turn on goes last.' }),
      choice({ id: 'f-signup_policy', label: 'Who can sign up', name: 'signup_policy', value: value.signup_policy, options: [['invited', 'Invited only'], ['open', 'Anyone']] }),
      list({ id: 'f-allowed_domains', label: 'Allowed email domains', name: 'allowed_domains', values: value.allowed_domains, pattern: HOST, placeholder: 'example.com', hint: 'People with these domains join without an invitation.' }),
      list({ id: 'f-google_hosted_domains', label: 'Google Workspace domains', name: 'google_hosted_domains', values: value.google_hosted_domains, pattern: HOST, placeholder: 'example.com', hint: 'Only these Workspace domains may sign in with Google. Leave empty to allow any Google account.' }),
      choice({ id: 'f-mfa', label: 'Two-factor', name: 'mfa', value: value.mfa, options: [['off', 'Off'], ['optional', 'Optional'], ['required', 'Required']] }),
          amount({ id: 'f-mfa_trusted_device_days', label: 'Remember browsers for', name: 'mfa_trusted_device_days', value: value.mfa_trusted_device_days, unit: 'days', min: 0, max: 90, hint: '0 asks every time.' }),
      toggle({ id: 'f-classic_oidc', label: 'Classic OpenID Connect', desc: 'Lets this app leave out PKCE and the nonce, as OpenID Connect libraries written before OAuth 2.1 do. Keep it off unless the app’s library needs it.', name: 'classic_oidc', on: SWITCHES.classic_oidc[0], checked: on(value, 'classic_oidc') }),
      choice({ id: 'f-id_token_signed_response_alg', label: 'ID token signature', stacked: true, name: 'id_token_signed_response_alg', value: value.id_token_signed_response_alg ?? 'ES256', options: [['ES256', 'ES256 (recommended)'], ['RS256', 'RS256, for libraries that need it']] }));
  const agents = formSection('agents', 'Agents', 'AI agents acting for a person in this app.',
      toggle({ id: 'f-agent_access', label: 'Agent access', desc: 'Turning it off revokes every agent grant for this app.', name: 'agent_access', on: SWITCHES.agent_access[0], checked: on(value, 'agent_access') }),
      checks({ id: 'f-agent_registration_methods', label: 'How agents register', name: 'agent_registration_methods', options: ordered(value.agent_registration_methods, { metadata_document: 'Metadata document', dynamic: 'Dynamic registration' }),
          chosen: value.agent_registration_methods, hint: 'Dynamic registration lets an agent register itself, so its name is not verified.' }),
      pairs({ id: 'f-agent_scope_catalogue', label: 'Scopes', name: 'agent_scope_catalogue', values: value.agent_scope_catalogue, keyLabel: 'Scope', valueLabel: 'What people see at consent',
          keyPlaceholder: 'notes:read', valuePlaceholder: 'Read your notes', addLabel: 'Add scope' }),
      list({ id: 'f-agent_resource_prefixes', label: 'Resources', name: 'agent_resource_prefixes', values: value.agent_resource_prefixes, pattern: '^https://', placeholder: 'https://notes.example/w/', hint: 'Agents may ask for URLs that start with one of these.' }),
      list({ id: 'f-agent_allowlist', label: 'Allowed agents', name: 'agent_allowlist', values: value.agent_allowlist, placeholder: 'agent.example.com', hint: 'An agent’s host or its full client URL. Leave empty to allow any agent.' }),
      amount({ id: 'f-agent_max_grant_days', label: 'Longest grant', name: 'agent_max_grant_days', value: value.agent_max_grant_days, unit: 'days', min: 1, hint: 'People approve again after this long.' }),
      amount({ id: 'f-agent_token_rate', label: 'Token requests per agent', name: 'agent_token_rate', value: value.agent_token_rate ?? 3000, unit: 'a minute', min: 10, max: 100000, hint: 'For each agent, such as ChatGPT or Claude, across everyone who uses it here. Each connection also has its own limit of 60 a minute.' }),
      toggle({ id: 'f-agent_consent_mfa', label: 'Second factor at consent', desc: 'Ask for a code or a passkey before a person approves an agent.', name: 'agent_consent_mfa', on: SWITCHES.agent_consent_mfa[0], checked: on(value, 'agent_consent_mfa') }),
      toggle({ id: 'f-agent_dpop', label: 'Require key-bound tokens', desc: 'Agents must prove a key with every request (DPoP), so a stolen token is useless.', name: 'agent_dpop', on: SWITCHES.agent_dpop[0], checked: on(value, 'agent_dpop') }));
  const machines = formSection('machines', 'Machines and events', 'Services calling each other, and events about people.',
      pairs({ id: 'f-token_exchange_from', label: 'Token exchange', name: 'token_exchange_from', values: exchangePairs(value), keyLabel: 'App',
          valueLabel: 'Scopes it may ask for', keyPlaceholder: 'reports', valuePlaceholder: 'notes:read notes:write', addLabel: 'Add app', hint: 'Apps that may swap a token they hold for one aimed at this app. Put a space between scopes.' }),
      toggle({ id: 'f-user_events', label: 'User events', desc: 'Send this app a signed event when a person’s profile changes or they are deleted.', name: 'user_events', on: SWITCHES.user_events[0], checked: on(value, 'user_events') }));
  const more = formSection('advanced', 'Advanced', 'Overrides for this app only.', advanced('Override branding',
      jsonField({ id: 'f-branding', label: 'Branding', name: 'branding', value: value.branding, hint: 'Overrides the realm’s name, look, words, links and logos for this app. The Branding page lists the fields.' })));
  return [app, callbacks, signIn, agents, machines, more];
}
