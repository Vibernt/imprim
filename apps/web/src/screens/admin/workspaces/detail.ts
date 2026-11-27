import { html, nothing } from 'lit';
import { href } from '../../../lib/router';
import { card } from '../../page-layout';
import { rowMenu } from '../../row-menu';
import { confirmInline } from '../realm-ui';
import { recordLayout } from '../record-layout';
import { workspaceProducts } from './products';
import { members } from './members';
import { nameField } from './forms';
import { activity, holdReason, summary } from './summary';
import { workspacePath, type Controls, type Submit, type Workspace } from './types';

export const workspaceActionsId = 'workspace-actions';

export const workspaceActions = (workspace: Workspace, pending: boolean, open: () => void) =>
  rowMenu(workspaceActionsId, 'More actions for ' + workspace.name, [
    { label: 'Rename', run: open },
    workspace.holds.length
      ? { label: 'Close workspace', danger: true, disabledReason: holdReason, reasonId: 'im-workspace-hold-reason' }
      : { label: 'Close workspace', danger: true, href: href(workspacePath(workspace.id) + '/close') },
  ], pending);

const rename = (workspace: Workspace, { pending, submit, cancel }: Controls) => card('Rename workspace', html`
  <form class="fd-form" method="post" ?inert=${pending} @submit=${(event: SubmitEvent) => submit('rename', event)}>
    ${nameField(workspace.name)}
    <div class="fd-form-actions">
      <button class="fd-btn" type="button" data-variant="ghost" @click=${() => cancel(workspaceActionsId)}>Cancel</button>
      <button class="fd-btn" type="submit" data-variant="outline" ?disabled=${pending}>Save name</button>
    </div>
  </form>`);

export const workspaceDetail = (workspace: Workspace, controls: Controls) => recordLayout(html`
  ${controls.renaming && workspace.editable ? rename(workspace, controls) : nothing}
  ${members(workspace, controls)}
  ${workspaceProducts(workspace, controls)}
  ${activity(workspace)}
`, summary(workspace));

export const closeWorkspace = (workspace: Workspace, pending: boolean, submit: Submit) => card(workspace.name, html`
    <div class="fd-callout" data-tone="warning"><i class="fd-callout-icon" data-icon="triangle-alert" aria-hidden="true"></i><div class="fd-callout-content">
      <p class="fd-callout-body">Closing permanently ends access granted through this workspace.</p>
    </div></div>
    ${confirmInline('workspace-confirm-name', workspace.name, 'Close workspace', pending, event => submit('close', event),
      html`<a class="fd-btn" data-variant="ghost" href=${workspacePath(workspace.id)}>Cancel</a>`)}
`);
