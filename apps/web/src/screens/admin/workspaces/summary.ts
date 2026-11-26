import { html, type TemplateResult } from 'lit';
import { eventLabel } from '../audit-events';
import { card } from '../../page-layout';
import { cap, empty, keyValues, link, mono, status, table, when } from '../realm-ui';
import type { Workspace } from './types';

export const products = (values: string[]) => values.length ? html`${values.map((name, i) => html`${i ? ', ' : ''}${mono(name)}`)}` : 'None';
export const summary = (workspace: Workspace) => keyValues([
  ['Workspace ID', mono(workspace.id)], ['Kind', cap(workspace.kind)],
  ['Status', status(cap(workspace.status), workspace.editable ? 'success' : 'neutral')],
]);

export const optionalTable = (label: string, headers: string[], rows: (TemplateResult | string)[][], description: string) =>
  rows.length ? table(label, headers, rows) : empty('No ' + label.toLowerCase(), description);

const noActivity = (message: string) => html`<p class="fd-muted">${message}</p>`;

export const activity = (workspace: Workspace) => html`
  ${card('Resources', workspace.resources.length
    ? table('Registered resources', ['Resource', 'Client ID'], workspace.resources.map(row => [mono(row.resource), mono(row.client_id)]))
    : noActivity('No registered resources.'))}
  ${card('Holds', workspace.holds.length
    ? table('Holds', ['Client ID', 'Reason'], workspace.holds.map(row => [mono(row.client_id), row.reason]))
    : noActivity('No holds.'))}
  ${card('Audit', workspace.audit.length ? html`
    ${table('Audit events', ['Event', 'Actor', 'Time'], workspace.audit.map(row =>
      [eventLabel(row.event), row.actor ? mono(row.actor) : '—', when(row.created)]))}
    <div class="fd-row">${link('/admin/audit?' + new URLSearchParams({ target: workspace.id }), 'View audit log')}</div>
  ` : noActivity('No audit events.'))}
`;
