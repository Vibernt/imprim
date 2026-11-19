import { html, nothing, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../lib/icon';
import { href } from '../../lib/router';

type Cell = string | number | TemplateResult;
export const mono = (text: Cell) => html`<code class="fd-code">${text}</code>`;
export const link = (path: string, label: string) => html`<a class="fd-link" href=${href(path)}>${label}</a>`;
export const segment = (id: string) => encodeURIComponent(id);
// The literal /new is reserved for registration. Existing clients can still have that ID.
export const clientPath = (id: string) => '/admin/clients/' + (id === 'new' ? '%6Eew' : segment(id));
export const userPath = (id: string) => '/admin/users/' + segment(id);
export const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const tones: Record<string, string> = { active: 'success', blocked: 'danger', deleted: 'neutral', disabled: 'neutral', pending: 'warning', expired: 'danger' };
export const status = (value: string, tone = tones[value]) => html`<span class="fd-status" data-tone=${tone ?? nothing}>${cap(value)}</span>`;
export const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export const table = (name: string, headings: string[], rows: Cell[][]) => html`
  <div class="fd-table-wrap"><div class="fd-table-scroll" tabindex="0" role="region" aria-label=${name}>
    <table class="fd-table" aria-label=${name}>
      <thead><tr>${headings.map(heading => html`<th scope="col">${heading}</th>`)}</tr></thead>
      <tbody>${rows.map(row => html`<tr>${row.map(value => html`<td>${value}</td>`)}</tr>`)}</tbody>
    </table>
  </div></div>`;

export const empty = (title: string, text: string) => html`
  <div class="fd-empty"><h2 class="fd-h3">${title}</h2><p class="fd-empty-text">${text}</p></div>`;

export function card(title: string, content: TemplateResult, description?: string) {
  return html`<section class="fd-card">
    <div class="fd-card-head"><div class="fd-card-heading"><h2 class="fd-title">${title}</h2>
      ${description ? html`<p class="fd-card-desc">${description}</p>` : nothing}
    </div></div>
    ${content}
  </section>`;
}

export const facts = (rows: [string, Cell][]) => html`
  <dl class="fd-kv" data-cols="2">${rows.map(([label, value]) => html`
    <div class="fd-kv-item"><dt class="fd-kv-key">${label}</dt><dd class="fd-kv-value"><span class="fd-kv-text">${value}</span></dd></div>`)}</dl>`;

export const nextPage = (path: string, query: URLSearchParams, cursor: string | number | null) => {
  if (cursor === null) return nothing;
  const next = new URLSearchParams(query);
  next.set('before', String(cursor));
  return html`<nav class="fd-pagination" aria-label="Pagination">
    <a class="fd-btn" data-variant="ghost" rel="next" href=${href(path + '?' + next)}>Next page ${icon('chevron-right')}</a>
  </nav>`;
};

export function confirmPhrase(options: {
  id: string; phrase: string; label: string; action: string; pending: boolean;
  cancel: () => void; submit: (phrase: string, data: FormData) => void; fields?: TemplateResult;
}) {
  const submit = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (options.pending) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const phrase = data.get('confirm');
    if (phrase === options.phrase) {
      options.submit(phrase, data);
    } else {
      const input = (event.currentTarget as HTMLFormElement).elements.namedItem('confirm') as HTMLInputElement;
      input.setCustomValidity('Type the text exactly as shown.');
      input.reportValidity();
    }
  };
  return html`${keyed(`${options.id}:${options.action}:${options.phrase}`, html`
    <form class="fd-confirm-inline" method="post" data-fd-confirm-inline data-confirm=${options.phrase} @submit=${submit}>
      <fieldset class="fd-stack im-fieldset" data-gap="3" ?disabled=${options.pending}>
        ${options.fields ?? nothing}
        <div class="fd-field">
          <label class="fd-field-label" for=${options.id}>${options.label}</label>
          <input class="fd-input" id=${options.id} name="confirm" data-fd-confirm-input autocomplete="off"
            spellcheck="false" autocapitalize="off" aria-describedby=${options.id + '-rule'} required
            @input=${(event: Event) => (event.currentTarget as HTMLInputElement).setCustomValidity('')}>
          <p class="fd-confirm-inline-rule" id=${options.id + '-rule'} data-fd-confirm-rule>Type ${mono(options.phrase)} exactly as shown.</p>
        </div>
        <div class="fd-form-actions">
          <button class="fd-btn" type="button" data-variant="ghost" @click=${options.cancel}>Cancel</button>
          <button class="fd-btn" type="submit" data-variant="danger" data-fd-confirm-submit>${options.action}</button>
        </div>
      </fieldset>
    </form>`)}`;
}
