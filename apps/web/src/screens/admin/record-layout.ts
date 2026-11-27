import { html, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';

export function recordLayout(main: TemplateResult, details: TemplateResult) {
  return html`<div class="fd-split">
    <div class="fd-split-main fd-stack" data-gap="6">${main}</div>
    <aside class="fd-panel" aria-labelledby="im-record-details">
      <div class="fd-panel-head"><h2 class="fd-panel-title" id="im-record-details">Details</h2></div>
      <div class="fd-stack" data-gap="5">${details}</div>
    </aside>
  </div>`;
}

type Fact = [label: string, value: string | number | TemplateResult, copy?: string];
export function recordFacts(rows: Fact[]) {
  return html`<dl class="fd-kv">${rows.map(([label, value, copy]) => html`
    <div class="fd-kv-item">
      <dt class="fd-kv-key">${label}</dt>
      ${copy === undefined ? html`<dd class="fd-kv-value">${value}</dd>` :
        keyed(copy, html`<dd class="fd-kv-value" data-copy=${copy}>${value}</dd>`)}
    </div>`)}</dl>`;
}
