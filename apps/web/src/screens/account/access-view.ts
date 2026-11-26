import { html, nothing, type TemplateResult } from 'lit';
import { t } from '../../lib/i18n';
import { card, setting } from '../page-layout';

export const when = (value: number | null) => value === null ? t('Never') :
  new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
export const initial = (name: string) => Array.from(name)[0]?.toLocaleUpperCase(document.documentElement.lang);

interface Row { title: string; description: string; meta?: string | TemplateResult; trail: TemplateResult }
export const list = (label: string, rows: Row[]) => html`
  <div role="group" aria-label=${label}>${rows.map(row => setting(row.title, html`
    ${row.description}${row.meta ? html`<div>${row.meta}</div>` : nothing}`, row.trail))}</div>`;

export const empty = (title: string, description = '') => html`
  <div class="fd-stack" data-gap="1"><p class="fd-small fd-muted">${title}</p>
    ${description ? html`<p class="fd-small fd-muted">${description}</p>` : nothing}</div>`;

export const section = (title: string, description: string, body: TemplateResult) => card(title, body, description);
