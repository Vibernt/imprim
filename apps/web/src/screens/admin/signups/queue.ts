import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { icon } from '../../../lib/icon';
import { when } from '../core-view';
import type { SignupRow } from './view';

const dateLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function signupQueue(rows: SignupRow[], selected: SignupRow | undefined, open: boolean,
  select: (id: string) => void, content: TemplateResult | typeof nothing) {
  if (!selected) return html`<div class="fd-queue">
    <div class="fd-empty" data-size="lg">
      <span class="fd-empty-icon">${icon('check-check')}</span>
      <h2 class="fd-empty-title">No requests waiting</h2>
      <p class="fd-empty-text">New requests appear here once the applicant verifies their email.</p>
    </div>
  </div>`;
  return html`<div class="fd-queue" data-view=${open ? 'case' : 'list'}>
    <nav class="fd-queue-list" aria-label="Pending requests">
      <div class="fd-queue-group" role="group" aria-labelledby="signup-queue-label">
        <p class="fd-queue-group-label" id="signup-queue-label">Pending requests <span class="fd-queue-count">${rows.length}</span></p>
        ${repeat(rows, row => row.id, row => html`
          <button class="fd-queue-item" type="button" data-value=${row.id} aria-current=${row === selected ? 'true' : nothing}
            @fd:select=${() => select(row.id)}>
            <span class="fd-tile" data-size="28">${icon('user')}</span>
            <span class="fd-queue-text">
              <span class="fd-queue-title im-breakable">${row.email}</span>
              <span class="fd-queue-meta">${row.workspace_name} · ${row.product}</span>
            </span>
            <time class="fd-queue-age" datetime=${new Date(row.created).toISOString()} title=${when(row.created)}>${dateLabel.format(row.created)}</time>
          </button>`)}
      </div>
    </nav>
    <div class="fd-queue-case">
      <button class="fd-btn fd-queue-back" type="button" data-variant="ghost" data-size="sm">${icon('arrow-left')}<span>All requests</span></button>
      ${content}
    </div>
  </div>`;
}
