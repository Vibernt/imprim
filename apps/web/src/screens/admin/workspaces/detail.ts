import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { card, setting } from '../../page-layout';
import { confirmInline } from '../realm-ui';
import { nameField, productField, submitButton } from './forms';
import { invitations, members } from './members';
import { activity, summary } from './summary';
import { workspacePath, type Submit, type Workspace } from './types';

const configuration = (workspace: Workspace, pending: boolean, submit: Submit) => html`
  ${card('Name', html`
    <form method="post" @submit=${(event: SubmitEvent) => submit('rename', event)}>
      <fieldset class="fd-setting" ?disabled=${pending}>
        <legend class="fd-sr-only">Name</legend>
        <div class="fd-setting-text">${nameField(workspace.name)}</div>
        <div class="fd-setting-control">${submitButton('Save name')}</div>
      </fieldset>
    </form>`)}
  ${card('Edit products', html`
    <form method="post" @submit=${(event: SubmitEvent) => submit('products', event)}>
      <fieldset class="fd-setting" ?disabled=${pending}>
        <legend class="fd-sr-only">Edit products</legend>
        <div class="fd-setting-text fd-stack" data-gap="3">
          ${productField('add', 'Add products')}
          ${productField('remove', 'Remove products')}
        </div>
        <div class="fd-setting-control">${submitButton('Save products')}</div>
      </fieldset>
    </form>`)}
`;

export const workspaceDetail = (workspace: Workspace, pending: boolean, submit: Submit) => keyed(workspace, html`
  <div class="fd-stack" data-gap="6">
    ${summary(workspace)}
    ${workspace.editable ? configuration(workspace, pending, submit) : nothing}
    ${members(workspace, pending, submit)}
    ${invitations(workspace, pending, submit)}
    ${activity(workspace)}
    ${workspace.editable ? card('Close workspace', workspace.holds.length
      ? html`<p class="fd-muted">Apps must release their holds before you can close this workspace.</p>`
      : setting('Permanently end workspace access', '', html`
        <a class="fd-btn" data-variant="danger" href=${workspacePath(workspace.id) + '/close'}>Review closure</a>`, true)) : nothing}
  </div>`);

export const closeWorkspace = (workspace: Workspace, pending: boolean, submit: Submit) => card(workspace.name, html`
    <div class="fd-callout" data-tone="warning"><i class="fd-callout-icon" data-icon="triangle-alert" aria-hidden="true"></i><div class="fd-callout-content">
      <p class="fd-callout-body">Closing permanently ends access granted through this workspace.</p>
    </div></div>
    ${confirmInline('workspace-confirm-name', workspace.name, 'Close workspace', pending, event => submit('close', event),
      html`<a class="fd-btn" data-variant="ghost" href=${workspacePath(workspace.id)}>Cancel</a>`)}
`);
