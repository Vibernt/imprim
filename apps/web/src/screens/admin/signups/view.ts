import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../../lib/icon';
import { href, navigate } from '../../../lib/router';
import { cap, confirmPhrase, mono, status, table, when } from '../core-view';

export const path = '/admin/signups';
const statuses = ['pending', 'approved', 'declined', 'expired'] as const;
type Status = typeof statuses[number];
export type Decision = 'approve' | 'decline';
export interface SignupRow {
  id: string; email: string; workspace_name: string; product: string; client_id: string;
  app_name: string | null; status: Status; created: number; reason: string | null;
}

export const actionId = (id: string, action: Decision) => `signup-${id}-${action}`;
export const confirmationId = 'signup-confirm-email';

export function statusFilter(value: string) {
  const active = value !== 'pending';
  return keyed(value, html`<div class="fd-toolbar"><div class="fd-toolbar-filters" role="group" aria-label="Filters">
    <div class="fd-filter" ?data-active=${active} data-default="Pending"
      @fd:change=${(event: CustomEvent<{ value: string | null }>) => { if (event.detail.value === null) void navigate(path); }}>
      <button class="fd-filter-trigger" type="button" data-fd-menu="signup-status-menu" aria-haspopup="menu" aria-expanded="false">
        ${icon('circle-dot')}<span class="fd-filter-value">${cap(value)}</span>${icon('chevron-down')}
      </button>
      ${active ? html`<button class="fd-filter-clear" type="button" aria-label="Clear status filter">${icon('x')}</button>` : nothing}
    </div>
    <div id="signup-status-menu" class="fd-menu" role="menu" aria-label="Request status" popover>
      ${statuses.map(value => html`<a class="fd-menu-item" role="menuitem"
        href=${href(value === 'pending' ? path : path + '?status=' + value)}>${cap(value)}</a>`)}
    </div>
  </div></div>`);
}

function confirmation(row: SignupRow, action: Decision, pending: boolean, cancel: () => void,
  submit: (body: object) => void) {
  return html`<div class="fd-column" data-size="sm">
    ${confirmPhrase({ id: confirmationId, phrase: row.email, label: 'Type the email to confirm',
      action: cap(action) + ' request', pending, variant: action === 'approve' ? 'primary' : 'danger', cancel,
      submit: (_, data) => submit(action === 'decline' ? { reason: data.get('reason') } : {}),
      fields: action === 'decline' ? html`<div class="fd-field">
        <label class="fd-field-label" for="signup-decline-reason">Reason for administrators (optional)</label>
        <textarea id="signup-decline-reason" class="fd-textarea" name="reason" maxlength="500" rows="2"></textarea>
      </div>` : undefined })}
  </div>`;
}

export function signupTable(rows: SignupRow[], selection: { id: string; action: Decision } | undefined,
  pending: boolean, select: (id: string, action: Decision) => void, cancel: () => void,
  submit: (id: string, action: Decision, body: object) => void) {
  return table('Sign-up requests', ['Email', 'Workspace name', 'Product / app', 'Requested', 'Status', 'Actions'],
    rows.map(row => [
      row.email, row.workspace_name,
      html`<div class="fd-table-two"><span>${mono(row.product)}</span><span class="fd-table-sub">${row.app_name ?? row.client_id}</span></div>`,
      when(row.created),
      html`<div class="fd-table-two">
        ${status(row.status, row.status === 'approved' ? 'success' : undefined)}
        ${row.reason ? html`<span class="fd-table-sub fd-table-trunc" title=${row.reason}>${row.reason}</span>` : nothing}
      </div>`,
      row.status !== 'pending' ? '—' : html`
        <button id=${actionId(row.id, 'approve')} class="fd-btn" type="button" data-size="sm" data-variant="outline"
          ?disabled=${pending} @click=${() => select(row.id, 'approve')}>Approve</button>
        <button id=${actionId(row.id, 'decline')} class="fd-btn" type="button" data-size="sm" data-variant="ghost"
          ?disabled=${pending} @click=${() => select(row.id, 'decline')}>Decline</button>`,
    ]),
    ['No requests in this status', 'Choose another status or check again later.'],
    rows.map(row => selection?.id === row.id && row.status === 'pending'
      ? confirmation(row, selection.action, pending, cancel, body => submit(row.id, selection.action, body)) : nothing));
}
