import { html, nothing } from 'lit';
import { icon } from '../../../lib/icon';
import { eventLabel } from '../audit-events';
import { card } from '../../page-layout';
import { status } from '../core-view';
import { recordFacts } from '../record-layout';
import { cap, link, mono, table, when } from '../realm-ui';
import type { Workspace } from './types';

export const products = (values: string[]) => values.length ? html`${values.map((name, i) => html`${i ? ', ' : ''}${mono(name)}`)}` : 'None';
export const kind = (workspace: Workspace) => cap(workspace.kind) + ' workspace';
export const workspaceStatus = (workspace: Workspace) => status(workspace.status, workspace.status === 'active' ? 'success' : 'neutral', 'pill');
export const holdReason = 'Apps must release their holds first.';

export const summary = (workspace: Workspace) => recordFacts([
  ['Workspace ID', mono(workspace.id)], ['Kind', cap(workspace.kind)], ['Status', workspaceStatus(workspace)],
  ['Holds', workspace.holds.length ? html`
    <div class="fd-reason">
      <ul class="fd-stack" data-gap="1">
        ${workspace.holds.map(hold => html`<li>${mono(hold.client_id)} · ${hold.reason}</li>`)}
      </ul>
      ${workspace.editable ? html`<p class="fd-reason-text" id="im-workspace-hold-reason">
        ${icon('lock')}<span><span class="fd-reason-why">${holdReason}</span></span>
      </p>` : nothing}
    </div>` : 'None'],
  ['Registered resources', workspace.resources.length ? html`<ul class="fd-stack" data-gap="1">
    ${workspace.resources.map(resource => html`<li>${mono(resource.resource)} · ${mono(resource.client_id)}</li>`)}
  </ul>` : 'None'],
]);

export const activity = (workspace: Workspace) => card('Recent activity', html`
  ${table('Audit events', ['Event', 'Actor', 'Time'], workspace.audit.map(row =>
    [eventLabel(row.event), row.actor ? mono(row.actor) : '—', when(row.created)]),
    ['No audit events', 'Recent changes to this workspace appear here.'], { emptyOnly: true })}
  <div class="fd-row">${link('/admin/audit?' + new URLSearchParams({ target: workspace.id }), 'View audit log')}</div>
`);
