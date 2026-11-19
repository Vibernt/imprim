import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { confirmInline, formSection } from '../realm-ui';
import { nameField, productField, submitButton } from './forms';
import { invitations, members } from './members';
import { activity, summary } from './summary';
import { workspacePath, type Submit, type Workspace } from './types';

const configuration = (workspace: Workspace, pending: boolean, submit: Submit) => html`
  <div class="fd-grid" data-min="lg" data-cols="2" data-gap="6">
    <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('rename', event)}>
      <fieldset class="im-fieldset" ?disabled=${pending}>
        ${formSection('workspace-edit-name', 'Name', html`${nameField(workspace.name)}${submitButton('Save name')}`)}
      </fieldset>
    </form>
    <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('products', event)}>
      <fieldset class="im-fieldset" ?disabled=${pending}>
        ${formSection('workspace-edit-products', 'Edit products', html`
          ${productField('add', 'Add products')}${productField('remove', 'Remove products')}${submitButton('Save products')}`)}
      </fieldset>
    </form>
  </div>`;

export const workspaceDetail = (workspace: Workspace, pending: boolean, submit: Submit) => keyed(workspace, html`
  <div class="fd-stack" data-gap="6">
    ${summary(workspace)}
    ${workspace.editable ? configuration(workspace, pending, submit) : nothing}
    ${members(workspace, pending, submit)}
    ${invitations(workspace, pending, submit)}
    ${activity(workspace)}
    ${workspace.editable ? html`
      <section class="fd-stack" data-gap="3">
        <h2 class="fd-h2">Close workspace</h2>
        ${workspace.holds.length ? html`<p class="fd-muted">Apps must release their holds before you can close this workspace.</p>`
          : html`<div><a class="fd-btn" data-variant="outline" href=${workspacePath(workspace.id) + '/close'}>Review closure</a></div>`}
      </section>` : nothing}
  </div>`);

export const closeWorkspace = (workspace: Workspace, pending: boolean, submit: Submit) => html`
  <section class="fd-stack" data-gap="4">
    <div class="fd-callout" data-tone="warning"><div class="fd-callout-content">
      <p class="fd-callout-title">${workspace.name}</p>
      <p class="fd-callout-body">Closing permanently ends access granted through this workspace.</p>
    </div></div>
    ${confirmInline('workspace-confirm-name', workspace.name, 'Close workspace', pending, event => submit('close', event),
      html`<a class="fd-btn" data-variant="ghost" href=${workspacePath(workspace.id)}>Cancel</a>`)}
  </section>`;
