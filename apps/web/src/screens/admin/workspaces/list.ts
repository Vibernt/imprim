import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../../lib/icon';
import { navigate } from '../../../lib/router';
import { cap, empty, link, status, table } from '../realm-ui';
import { products } from './summary';
import { root, workspacePath, type ListPage } from './types';

const options = [['', 'All statuses'], ['active', 'Active'], ['closed', 'Closed']] as const;

function url(filter: string, before?: string): string {
  const query = new URLSearchParams();
  if (filter) query.set('status', filter);
  if (before) query.set('before', before);
  return query.size ? root + '?' + query : root;
}

function statusFilter(filter: string) {
  return keyed(filter, html`<div class="fd-filter-bar">
    <div class="fd-filter" ?data-active=${Boolean(filter)} data-default="All statuses"
      @fd:change=${(event: CustomEvent<{ value: string | null }>) => { if (event.detail.value === null) void navigate(root); }}>
      <button class="fd-filter-trigger" type="button" data-fd-menu="workspace-status-menu" aria-haspopup="menu" aria-expanded="false">
        ${icon('circle-dot')}<span class="fd-filter-value">${filter ? cap(filter) : 'All statuses'}</span>${icon('chevron-down')}
      </button>
      ${filter ? html`<button class="fd-filter-clear" type="button" aria-label="Clear status filter">${icon('x')}</button>` : nothing}
    </div>
    <div id="workspace-status-menu" class="fd-menu" role="menu" aria-label="Workspace status" popover>
      ${options.map(([value, label]) => html`<a class="fd-menu-item" role="menuitem" href=${url(value)}>${label}</a>`)}
    </div>
  </div>`);
}

export const workspaceList = (data: ListPage, filter: string, before: string | null) => html`
  <div class="fd-stack" data-gap="4">
    ${statusFilter(filter)}
    ${data.workspaces.length ? table('Workspaces', ['Name', 'Kind', 'Status', 'Products', 'Members'],
      data.workspaces.map(row => [link(workspacePath(row.id), row.name), cap(row.kind),
        status(cap(row.status), row.status === 'active' ? 'success' : 'neutral'), products(row.products), row.members]))
      : filter ? empty('No workspaces match', 'Choose another status.') : empty('No workspaces yet', 'Create a team to share membership across products.')}
    ${data.next || before ? html`
      <nav class="fd-pagination" aria-label="Workspace pages"><div class="fd-pagination-pages">
        ${before ? html`<a class="fd-btn" data-variant="ghost" href=${url(filter)}>First page</a>` : nothing}
        ${data.next ? html`<a class="fd-btn" data-variant="ghost" href=${url(filter, data.next)}>Next page</a>` : nothing}
      </div></nav>` : nothing}
  </div>`;
