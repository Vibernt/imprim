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
export const status = (value: string, tone = tones[value], variant?: 'pill') => html`
  <span class="fd-status" data-tone=${tone ?? nothing} data-variant=${variant ?? nothing}>${cap(value)}</span>`;
export const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export { table } from './list-view';

export const empty = (title: string, text: string) => html`
  <div class="fd-empty"><h2 class="fd-h3">${title}</h2><p class="fd-empty-text">${text}</p></div>`;

export { card } from '../page-layout';

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
  cancel: () => void; submit: (phrase: string, data: FormData) => void; fields?: TemplateResult; variant?: 'primary' | 'danger';
}) {
  const submit = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (options.pending) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const typed = String(data.get('confirm') ?? '');
    if (typed === options.phrase) {
      options.submit(options.phrase, data);
    } else {
      const input = (event.currentTarget as HTMLFormElement).elements.namedItem('confirm') as HTMLInputElement;
      input.setCustomValidity('Type the text exactly as shown.');
      input.reportValidity();
    }
  };
  return html`${keyed(`${options.id}:${options.action}:${options.phrase}`, html`
    <form class="fd-confirm-inline" method="post" data-fd-confirm-inline data-confirm=${options.phrase} @submit=${submit}>
      <fieldset class="fd-stack" data-gap="3" ?disabled=${options.pending}>
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
          <button class="fd-btn" type="submit" data-variant=${options.variant ?? 'danger'} data-fd-confirm-submit>${options.action}</button>
        </div>
      </fieldset>
    </form>`)}`;
}
