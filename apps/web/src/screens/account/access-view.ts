import { html, nothing, type TemplateResult } from 'lit';
import { t } from '../../lib/i18n';
import { card, setting } from '../page-layout';

const dayFormat: Intl.DateTimeFormatOptions = { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' };
const timeFormat: Intl.DateTimeFormatOptions = { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' };
export const day = (value: number) => new Intl.DateTimeFormat(document.documentElement.lang, dayFormat).format(value);
export const when = (value: number | null) => value ? `${day(value)} ${new Intl.DateTimeFormat(document.documentElement.lang, timeFormat).format(value)}` : t('Never');

interface Row { title: string; description: string; meta?: string | TemplateResult; trail: TemplateResult }
export const list = (label: string, rows: Row[]) => html`
  <div role="group" aria-label=${label}>${rows.map(row => setting(row.title, html`
    ${row.description}${row.meta ? html`<div>${row.meta}</div>` : nothing}`, row.trail))}</div>`;

export const empty = (title: string, description: string) => html`
  <div class="fd-empty" data-size="sm"><p class="fd-empty-title">${title}</p><p class="fd-empty-text">${description}</p></div>`;

export const section = (title: string, description: string, body: TemplateResult) => card(title, body, description);
