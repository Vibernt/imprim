import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { t } from '../../lib/i18n';

export const when = (value: number | null) => value === null ? t('Never') :
  new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
export const initial = (name: string) => Array.from(name)[0]?.toLocaleUpperCase(document.documentElement.lang);

export const list = <T>(label: string, items: T[], key: (item: T) => string, row: (item: T) => TemplateResult) => html`
  <ul class="fd-list" data-divided aria-label=${label}>${repeat(items, key, row)}</ul>`;

export const empty = (title: string, description = '', action?: TemplateResult) => html`
  <div class="fd-empty" data-size="sm">
    <h3 class="fd-empty-title">${title}</h3>
    ${description ? html`<p class="fd-empty-text">${description}</p>` : nothing}
    ${action ? html`<div class="fd-empty-actions">${action}</div>` : nothing}
  </div>`;
