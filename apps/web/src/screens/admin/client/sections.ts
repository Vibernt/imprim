import { html } from 'lit';
import { text, list, pairs, choice, toggle, amount, formSection } from '../core-fields';
import { icon } from '../../../lib/icon';
import { clientBrandingFields } from './branding-fields';
import { agentFields } from './agent-fields';
import { redirectField, signInMethods } from './registration';
import { SWITCHES, exchangePairs, type Client, type ClientControls } from './model';
import { deliveryStatus } from './editor-panels';

const HOST = '^[a-z0-9-]+(\\.[a-z0-9-]+)+$';
const on = (value: Client, name: keyof typeof SWITCHES) => String(value[name]) === SWITCHES[name][0];

function workspaceFields(value: Client, controls: ClientControls) {
  const workspaceToggle = (name: 'personal_workspaces' | 'workspace_admin' | 'self_signup' | 'join_workspaces', label: string, desc: string, warning?: string) =>
    toggle({ id: 'f-' + name, name, label, desc, on: 'on', checked: value[name] === 'on', warning });
  const signupWarning = controls.selfSignup
    ? controls.invited ? 'Self-serve sign-up is on while Who can sign up is set to Invited only.'
      : !controls.email ? 'Self-serve sign-up needs the Email link method.' : undefined
    : undefined;
  return html`
    <div class="fd-stack" data-gap="3" role="group" aria-labelledby="workspaces-title">
      <h3 class="fd-title" id="workspaces-title">Workspaces</h3>
      ${choice({ id: 'f-workspaces', label: 'Where workspaces are managed', name: 'workspaces', value: value.workspaces,
        options: [['app', 'In this app'], ['shared', 'Shared through Imprim']],
        hint: !controls.shared && value.workspaces === 'shared' ? 'Saving turns off shared workspace options and removes workspace-choice resources.' : undefined })}
      <fieldset class="fd-stack" data-gap="3" ?disabled=${!controls.shared} ?hidden=${!controls.shared}>
        <legend class="fd-sr-only">Shared workspace settings</legend>
      ${text({ id: 'f-product', label: 'Product', name: 'product', value: value.product, mono: true, maxlength: 40,
        pattern: '[a-z][a-z0-9\\-]{1,39}', placeholder: 'notes', required: controls.shared, warning: controls.shared && !controls.product ? 'Enter a product ID for shared workspaces.' : undefined })}
      ${workspaceToggle('personal_workspaces', 'Personal workspaces', 'Let people create a personal workspace in this app.')}
      ${workspaceToggle('workspace_admin', 'Workspace administration', 'Let this app create team workspaces and manage their products.')}
      ${workspaceToggle('self_signup', 'Self-serve sign-up', 'Let people create a team workspace. Requires realm sign-up.', signupWarning)}
      ${workspaceToggle('join_workspaces', 'Join a workspace at sign-in', 'Let owners add this app’s product to their existing team workspace.')}
      </fieldset>
    </div>`;
}

export function clientSections(value: Client, controls: ClientControls, providers: Record<string, string>,
  delivery?: Parameters<typeof deliveryStatus>[0]) {
  const app = formSection('app', 'App', 'How this app is known here.',
      html`<div class="fd-copy-field" data-value=${value.id} data-noun="client ID">
        <span class="fd-copy-field-label">Client ID</span>
        <div class="fd-copy-field-actions">
          <button type="button" class="fd-btn" data-variant="ghost" data-icon-only
            data-fd-field-action="copy" aria-label="Copy client ID">${icon('copy')}</button>
        </div>
        <code class="fd-copy-field-value"></code>
      </div>`,
      toggle({ id: 'f-listed', name: 'listed', label: 'Show to everyone', checked: value.listed, on: '1',
        desc: "Lists this app on Imprim's pages for people who are signed out." }),
      text({ id: 'f-initiate_login_uri', label: 'App sign-in URL', name: 'initiate_login_uri', value: value.initiate_login_uri,
        mono: true, type: 'url', placeholder: 'https://notes.example.com/sign-in', hint: 'Use HTTPS on the same origin as a redirect URL.' }),
      clientBrandingFields(value.branding), workspaceFields(value, controls));
  const callbacks = formSection('callbacks', 'Callbacks', 'Where this app receives people and events.',
      redirectField(value),
      list({ id: 'f-post_logout_uris', label: 'Sign-out URLs', name: 'post_logout_uris', values: value.post_logout_uris, pattern: '^https?://',
        placeholder: 'https://notes.example.com/signed-out', hint: 'Where people may land after signing out.' }),
      text({ id: 'f-backchannel_uri', label: 'Back-channel URL', name: 'backchannel_uri', value: value.backchannel_uri, required: true,
        mono: true, type: 'url', placeholder: 'https://notes.example.com/backchannel', hint: 'Receives signed sign-out and revocation events.',
        warning: controls.backchannel ? undefined : 'Enter a back-channel URL so Imprim can end app sessions.' }),
      toggle({ id: 'f-dev', label: 'Development mode', desc: 'Allows http://localhost callbacks. Turn it off in production.',
        name: 'dev', on: SWITCHES.dev[0], checked: on(value, 'dev') }));
  const signIn = formSection('sign-in', 'Sign-in', 'How people get in, and who may.',
      signInMethods(value, providers),
      choice({ id: 'f-signup_policy', label: 'Who can sign up', name: 'signup_policy', value: value.signup_policy, options: [['invited', 'Invited only'], ['open', 'Anyone']] }),
      list({ id: 'f-allowed_domains', label: 'Allowed email domains', name: 'allowed_domains', values: value.allowed_domains, pattern: HOST, placeholder: 'example.com', hint: 'People with these domains join without an invitation.' }),
      list({ id: 'f-google_hosted_domains', label: 'Google Workspace domains', name: 'google_hosted_domains', values: value.google_hosted_domains, pattern: HOST, placeholder: 'example.com', hint: 'Only these Workspace domains may sign in with Google. Leave empty to allow any Google account.' }),
      choice({ id: 'f-mfa', label: 'Two-factor', name: 'mfa', value: value.mfa, options: [['off', 'Off'], ['optional', 'Optional'], ['required', 'Required']] }),
          amount({ id: 'f-mfa_trusted_device_days', label: 'Remember browsers for', name: 'mfa_trusted_device_days', value: value.mfa_trusted_device_days, unit: 'days', min: 0, max: 90, hint: '0 asks every time.' }),
      toggle({ id: 'f-classic_oidc', label: 'Classic OpenID Connect', desc: 'Lets this app leave out PKCE and the nonce, as OpenID Connect libraries written before OAuth 2.1 do. Keep it off unless the app’s library needs it.', name: 'classic_oidc', on: SWITCHES.classic_oidc[0], checked: on(value, 'classic_oidc'),
        warning: controls.classic && !value.draft && !value.confidential ? 'Classic OpenID Connect requires a confidential client.' : undefined }),
      choice({ id: 'f-id_token_signed_response_alg', label: 'ID token signature', stacked: true, name: 'id_token_signed_response_alg', value: value.id_token_signed_response_alg ?? 'ES256', options: [['ES256', 'ES256 (recommended)'], ['RS256', 'RS256, for libraries that need it']] }));
  const machines = formSection('machines', 'Machines and events', 'Services calling each other, and events about people.',
      pairs({ id: 'f-token_exchange_from', label: 'Token exchange', name: 'token_exchange_from', values: exchangePairs(value), keyLabel: 'App',
          valueLabel: 'Scopes it may ask for', keyPlaceholder: 'reports', valuePlaceholder: 'notes:read notes:write', addLabel: 'Add app', hint: 'Apps that may swap a token they hold for one aimed at this app. Put a space between scopes.' }),
      toggle({ id: 'f-user_events', label: 'User events', desc: 'Send this app a signed event when a person’s profile changes or they are deleted.', name: 'user_events', on: SWITCHES.user_events[0], checked: on(value, 'user_events') }));
  const backchannel = delivery && formSection('backchannel-delivery', 'Back-channel delivery', 'Signed events retry for 24 hours.',
    deliveryStatus(delivery));
  return [app, callbacks, signIn, agentFields(value, controls), machines, backchannel];
}
