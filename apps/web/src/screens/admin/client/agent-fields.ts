import { html } from 'lit';
import { amount, checks, formSection, list, pairs, toggle } from '../core-fields';
import type { Client, ClientControls } from './model';
import { ordered } from '../sign-in-methods';

export function agentFields(value: Client, controls: ClientControls) {
  return formSection('agents', 'Agents', 'AI agents acting for a person in this app.',
      toggle({ id: 'f-agent_access', label: 'Agent access', desc: 'Turning it off revokes every agent grant for this app.', name: 'agent_access', on: 'on', checked: value.agent_access === 'on',
        warning: !controls.agents && value.agent_workspace_resources.length ? 'Saving also removes workspace-choice resources.' : undefined }),
      html`<fieldset class="fd-stack" data-gap="4" ?disabled=${!controls.agents} ?hidden=${!controls.agents}>
        <legend class="fd-sr-only">Agent settings</legend>
        ${agentControls(value, controls)}
      </fieldset>`);
}

function agentControls(value: Client, controls: ClientControls) {
  return html`
    ${checks({ id: 'f-agent_registration_methods', label: 'How agents register', name: 'agent_registration_methods',
      options: ordered(value.agent_registration_methods, { metadata_document: 'Metadata document', dynamic: 'Dynamic registration' }),
      chosen: value.agent_registration_methods, hint: 'Dynamic registration lets an agent register itself, so its name is not verified.' })}
    ${pairs({ id: 'f-agent_scope_catalogue', label: 'Scopes', name: 'agent_scope_catalogue', values: value.agent_scope_catalogue,
      keyLabel: 'Scope', valueLabel: 'What people see at consent', keyPlaceholder: 'notes:read', valuePlaceholder: 'Read your notes', addLabel: 'Add scope' })}
    ${list({ id: 'f-agent_resource_prefixes', label: 'Resources', name: 'agent_resource_prefixes', values: value.agent_resource_prefixes,
      pattern: '^https://', placeholder: 'https://notes.example.com/w/', hint: 'Agents may ask for URLs that start with one of these.' })}
    <fieldset class="fd-stack" ?disabled=${!controls.shared} ?hidden=${!controls.shared}>
      <legend class="fd-sr-only">Shared workspace resources</legend>
      ${list({ id: 'f-agent_workspace_resources', label: 'Workspace-choice resources', name: 'agent_workspace_resources',
        values: value.agent_workspace_resources, pattern: '^https://', placeholder: 'https://app.example.com/mcp',
        hint: 'Up to 5 exact URLs under the resource prefixes. People choose a shared workspace at approval.' })}
    </fieldset>
    ${list({ id: 'f-agent_allowlist', label: 'Allowed agents', name: 'agent_allowlist', values: value.agent_allowlist,
      placeholder: 'agent.example.com', hint: 'An agent’s host or its full client URL. Leave empty to allow any agent.' })}
    ${amount({ id: 'f-agent_max_grant_days', label: 'Longest grant', name: 'agent_max_grant_days', value: value.agent_max_grant_days,
      unit: 'days', min: 1, hint: 'People approve again after this long.' })}
    ${amount({ id: 'f-agent_token_rate', label: 'Token requests per agent', name: 'agent_token_rate', value: value.agent_token_rate,
      unit: 'a minute', min: 10, max: 100000, hint: 'Each connection also has its own limit of 60 a minute.' })}
    ${toggle({ id: 'f-agent_consent_mfa', label: 'Two-step verification at consent', desc: 'Ask for a code or a passkey before a person approves an agent.',
      name: 'agent_consent_mfa', on: 'required', checked: value.agent_consent_mfa === 'required' })}
    ${toggle({ id: 'f-agent_dpop', label: 'Require key-bound tokens', desc: 'Agents prove a key with every request (DPoP).',
      name: 'agent_dpop', on: 'required', checked: value.agent_dpop === 'required' })}
  `;
}
