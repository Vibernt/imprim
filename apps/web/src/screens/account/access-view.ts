import { html, nothing, type TemplateResult } from 'lit';
import { t } from '../../lib/i18n';

const dayFormat: Intl.DateTimeFormatOptions = { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' };
const timeFormat: Intl.DateTimeFormatOptions = { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' };
export const day = (value: number) => new Intl.DateTimeFormat(document.documentElement.lang, dayFormat).format(value);
export const when = (value: number | null) => value ? `${day(value)} ${new Intl.DateTimeFormat(document.documentElement.lang, timeFormat).format(value)}` : t('Never');

interface Row { title: string; description: string; meta?: string | TemplateResult; trail: TemplateResult }
export const list = (label: string, rows: Row[]) => html`
  <ul class="fd-list" data-card aria-label=${label}>${rows.map(row => html`
    <li class="fd-list-row">
      <div class="fd-list-body"><span class="fd-list-title">${row.title}</span><span class="fd-list-desc">${row.description}</span></div>
      ${row.meta ? html`<span class="fd-list-meta">${row.meta}</span>` : nothing}
      <div class="fd-list-trail">${row.trail}</div>
    </li>`)}</ul>`;

export const empty = (title: string, description: string) => html`
  <div class="fd-empty"><p class="fd-empty-title">${title}</p><p class="fd-empty-text">${description}</p></div>`;

export const section = (title: string, description: string, body: TemplateResult) => html`
  <section class="fd-stack" data-gap="3"><div class="fd-stack" data-gap="1">
    <h2 class="fd-h2">${title}</h2><p class="fd-small fd-muted">${description}</p>
  </div>${body}</section>`;
