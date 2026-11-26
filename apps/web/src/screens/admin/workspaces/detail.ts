import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { card, fieldWithAction, setting } from '../../page-layout';
import { confirmInline } from '../realm-ui';
import { workspaceProducts } from './products';
import { members } from './members';
import { activity, summary } from './summary';
import { workspacePath, type Submit, type Workspace } from './types';

const configuration = (workspace: Workspace, pending: boolean, submit: Submit) => html`
  ${card('Name', html`
    <form class="fd-form" method="post" ?inert=${pending} @submit=${(event: SubmitEvent) => submit('rename', event)}>
      ${fieldWithAction('workspace-name', 'Workspace name', undefined, html`
        <input class="fd-input fd-grow" id="workspace-name" name="name" required maxlength="120" .value=${workspace.name}>`, html`
        <button class="fd-btn" type="submit" data-variant="outline" ?disabled=${pending}>Save name</button>`)}
    </form>`)}
`;

export const workspaceDetail = (workspace: Workspace, pending: boolean, submit: Submit) => keyed(workspace, html`
  <div class="fd-stack" data-gap="6">
    ${summary(workspace)}
    ${members(workspace, pending, submit)}
    ${workspaceProducts(workspace, pending, submit)}
    ${activity(workspace)}
    ${workspace.editable ? configuration(workspace, pending, submit) : nothing}
    ${workspace.editable ? card('Close workspace', workspace.holds.length
      ? html`<p class="fd-muted">Apps must release their holds before you can close this workspace.</p>`
      : setting('Permanently end workspace access', '', html`
        <a class="fd-btn" data-variant="secondary" href=${workspacePath(workspace.id) + '/close'}>Review closure</a>`, true)) : nothing}
  </div>`);

export const closeWorkspace = (workspace: Workspace, pending: boolean, submit: Submit) => card(workspace.name, html`
    <div class="fd-callout" data-tone="warning"><i class="fd-callout-icon" data-icon="triangle-alert" aria-hidden="true"></i><div class="fd-callout-content">
      <p class="fd-callout-body">Closing permanently ends access granted through this workspace.</p>
    </div></div>
    ${confirmInline('workspace-confirm-name', workspace.name, 'Close workspace', pending, event => submit('close', event),
      html`<a class="fd-btn" data-variant="ghost" href=${workspacePath(workspace.id)}>Cancel</a>`)}
`);
