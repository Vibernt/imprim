import { html, type TemplateResult } from 'lit';
import { card } from '../../page-layout';
import { cap, empty, keyValues, link, mono, status, table, when } from '../realm-ui';
import type { Workspace } from './types';

export const products = (values: string[]) => values.length ? html`${values.map((name, i) => html`${i ? ', ' : ''}${mono(name)}`)}` : 'None';
export const summary = (workspace: Workspace) => keyValues([
  ['Workspace ID', mono(workspace.id)], ['Kind', cap(workspace.kind)],
  ['Status', status(cap(workspace.status), workspace.editable ? 'success' : 'neutral')], ['Products', products(workspace.products)],
]);

export const optionalTable = (label: string, headers: string[], rows: (TemplateResult | string)[][], description: string) =>
  rows.length ? table(label, headers, rows) : empty('No ' + label.toLowerCase(), description);

export const activity = (workspace: Workspace) => html`
  ${card('Registered resources', optionalTable('Registered resources', ['Resource', 'Client ID'],
    workspace.resources.map(row => [mono(row.resource), mono(row.client_id)]), 'Registered app resources appear here.'))}
  ${card('Holds', optionalTable('Holds', ['Client ID', 'Reason'],
    workspace.holds.map(row => [mono(row.client_id), row.reason]), 'Holds from apps appear here.'))}
  ${card('Recent audit', html`
    ${optionalTable('Audit events', ['Event', 'Actor', 'Time'], workspace.audit.map(row =>
      [mono(row.event), row.actor ? mono(row.actor) : 'None', when(row.created)]), 'Workspace changes appear here.')}
    <div class="fd-row">${link('/admin/audit?' + new URLSearchParams({ target: workspace.id }), 'View audit log')}</div>`)}
`;
