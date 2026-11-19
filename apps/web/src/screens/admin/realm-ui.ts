import { html, nothing, type TemplateResult } from 'lit';
import { overlays } from 'fire-design';
import { keyed } from 'lit/directives/keyed.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { ApiError } from '../../lib/api';
import { icon } from '../../lib/icon';

type Content = TemplateResult | string | number | typeof nothing;
export const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export const when = (ms: number | null) => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'Never';
export const mono = (value: string) => html`<code class="fd-code">${value}</code>`;

export const notice = (title: string, description?: string, tone: 'success' | 'danger' = 'success') =>
  overlays.toast({ title, description, tone });

export function failed(error: unknown) {
  if (error instanceof ApiError && error.redirecting) return;
  notice('The request could not be completed', error instanceof Error ? error.message : undefined, 'danger');
}

export const empty = (title: string, description: string) => html`
  <div class="fd-empty"><h2 class="fd-empty-title">${title}</h2><p class="fd-empty-text">${description}</p></div>`;

export const link = (path: string, label: string) => html`<a class="fd-link" href=${path}>${label}</a>`;
export const backLink = (path: string, label: string) => html`<a class="fd-back" href=${path}>${icon('arrow-left')}<span>${label}</span></a>`;

export const status = (label: string, tone: 'success' | 'neutral' | 'warning' | 'danger') => html`
  <span class="fd-status" data-tone=${tone}>${label}</span>`;

export const keyValues = (pairs: readonly [string, Content][], cols = 2) => html`
  <dl class="fd-kv" data-cols=${cols}>${pairs.map(([label, value]) => html`
    <div class="fd-kv-item"><dt class="fd-kv-key">${label}</dt><dd class="fd-kv-value"><span class="fd-kv-text">${value}</span></dd></div>`)}
  </dl>`;

export const table = (label: string, headers: string[], rows: Content[][]) => html`
  <div class="fd-table-wrap"><div class="fd-table-scroll"><table class="fd-table" aria-label=${label}>
    <thead><tr>${headers.map(header => html`<th scope="col">${header}</th>`)}</tr></thead>
    <tbody>${rows.map(row => html`<tr>${row.map(cell => html`<td>${cell}</td>`)}</tr>`)}</tbody>
  </table></div></div>`;

export const formSection = (id: string, title: string, content: Content, description?: string) => html`
  <section class="fd-form-section" aria-labelledby=${id}>
    <header class="fd-form-section-head"><h2 class="fd-form-section-title" id=${id}>${title}</h2>
      ${description ? html`<p class="fd-form-section-desc">${description}</p>` : nothing}
    </header>
    <div class="fd-form-section-body">${content}</div>
  </section>`;

export function field(id: string, label: string, {
  name = id, value = '', type = 'text', required = false, max, placeholder, hint,
}: { name?: string; value?: string; type?: string; required?: boolean; max?: number; placeholder?: string; hint?: string } = {}) {
  return html`<div class="fd-field">
    <label class="fd-field-label" for=${id} ?data-required=${required}>${label}</label>
    <input class="fd-input" id=${id} name=${name} type=${type} .value=${value} ?required=${required}
      maxlength=${ifDefined(max)} placeholder=${ifDefined(placeholder)} aria-describedby=${ifDefined(hint ? id + '-hint' : undefined)}>
    ${hint ? html`<p class="fd-field-hint" id=${id + '-hint'}>${hint}</p>` : nothing}
  </div>`;
}

export function confirmInline(id: string, phrase: string, label: string, pending: boolean, submit: (event: SubmitEvent) => void, cancel: Content) {
  return keyed(phrase, html`
    <form class="fd-confirm-inline" method="post" data-fd-confirm-inline data-confirm=${phrase} @submit=${submit}>
      <fieldset class="fd-stack im-fieldset" data-gap="3" ?disabled=${pending}>
        <div class="fd-field">
          <label class="fd-field-label" for=${id}>Type <span class="fd-confirm-phrase">${phrase}</span> to confirm</label>
          <input class="fd-input" id=${id} name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false"
            required data-fd-confirm-input aria-describedby=${id + '-rule'}>
          <p class="fd-confirm-inline-rule" id=${id + '-rule'} data-fd-confirm-rule>Type it as shown. Case counts.</p>
        </div>
        <div class="fd-form-actions">${cancel}<button class="fd-btn" type="submit" data-variant="danger" data-fd-confirm-submit>${label}</button></div>
      </fieldset>
    </form>`);
}

export const formData = (event: SubmitEvent) => new FormData(event.currentTarget as HTMLFormElement);
