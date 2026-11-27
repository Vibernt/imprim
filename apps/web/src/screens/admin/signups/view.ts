import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../../lib/icon';
import { href, navigate } from '../../../lib/router';
import { cap } from '../core-view';

export const path = '/admin/signups';
const statuses = ['pending', 'approved', 'declined', 'expired'] as const;
type Status = typeof statuses[number];
export type Decision = 'approve' | 'decline';
export interface SignupRow {
  id: string; email: string; workspace_name: string; product: string; client_id: string;
  app_name: string | null; provider: 'google' | 'github' | null; status: Status; created: number; reason: string | null;
}

export const methodLabel = (row: SignupRow) => row.provider === 'google' ? 'Google' : row.provider === 'github' ? 'GitHub' : 'Email';

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
