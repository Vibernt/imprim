import { html } from 'lit';

export function securityAction(id: string, label: string, action: (() => void) | { id: string; confirmRow: string },
  pending: boolean, reason?: string) {
  if (reason) return html`<div class="fd-reason">
    <button class="fd-btn" data-variant="outline" type="button" aria-disabled="true" aria-describedby=${id}>${label}</button>
    <p class="fd-reason-text" id=${id}><i data-icon="lock" aria-hidden="true"></i><span><span class="fd-reason-why">${reason}</span></span></p>
  </div>`;
  if (typeof action === 'function') return html`<button class="fd-btn" data-variant="outline" type="button"
    ?disabled=${pending} @click=${action}>${label}</button>`;
  return html`<button class="fd-btn" data-variant="outline" type="button"
    ?disabled=${pending} id=${action.id} data-fd-confirm-row=${action.confirmRow}>${label}</button>`;
}
