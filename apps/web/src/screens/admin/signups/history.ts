import { html, nothing } from 'lit';
import { mono, status, table, when } from '../core-view';
import { methodLabel, type SignupRow } from './view';

export function signupHistory(rows: SignupRow[]) {
  return table('Sign-up requests', ['Email', 'Workspace name', 'Product / app', 'Sign-up method', 'Requested', 'Status'],
    rows.map(row => [
      row.email, row.workspace_name,
      html`<div class="fd-table-two"><span>${mono(row.product)}</span><span class="fd-table-sub">${row.app_name ?? row.client_id}</span></div>`,
      methodLabel(row), when(row.created),
      html`<div class="fd-table-two">
        ${status(row.status, row.status === 'approved' ? 'success' : undefined)}
        ${row.reason ? html`<span class="fd-table-sub">${row.reason}</span>` : nothing}
      </div>`,
    ]), ['No requests in this status', 'Choose another status or check again later.']);
}
