import { html, nothing, type TemplateResult } from 'lit';
import { icon } from '../../lib/icon';
import { t } from '../../lib/i18n';
import { initial, when } from './access-view';
import { rowMenu, type RowAction } from '../row-menu';

export const useTime = (value: number | null) => value === null ? t('Not used yet') : t('Used {date}', { date: when(value) });

interface Item {
  id: string;
  title: string;
  description: string;
  lead?: boolean;
  meta?: string;
  details?: TemplateResult;
  form?: TemplateResult | typeof nothing;
  confirmation?: TemplateResult;
  badge?: string;
  badgeTone?: 'warning' | 'success';
  actions?: RowAction[];
  trail?: TemplateResult;
  pending?: boolean;
  busy?: boolean;
}

export function connectionRow(item: Item) {
  const trail = item.actions?.length ? rowMenu(item.id, t('More actions for {name}', { name: item.title }),
    item.actions, item.pending || item.busy) : item.trail;
  return html`<li class="fd-list-row" aria-busy=${item.busy ? 'true' : nothing}>
    ${item.lead ? html`<span class="fd-list-lead" aria-hidden="true"><span class="fd-tile" data-size="36" data-tone="accent">${initial(item.title)}</span></span>` : nothing}
    <div class="fd-list-body">
      <div class="fd-row" data-wrap data-gap="2"><span class="fd-list-title">${item.title}</span>
        ${item.badge ? html`<span class="fd-badge" data-tone=${item.badgeTone ?? nothing}>${item.badge}</span>` : nothing}</div>
      <span class="fd-list-desc"><span class="im-breakable">${item.description}</span></span>
      ${item.details ? html`<details class="fd-disclosure">
        <summary class="fd-disclosure-trigger"><span>${t('Details')}</span>${icon('chevron-down')}</summary>
        <div class="fd-disclosure-panel"><div class="fd-disclosure-inner fd-stack" data-gap="1">${item.details}</div></div>
      </details>` : nothing}
      ${item.form}
    </div>
    ${item.meta ? html`<div class="fd-list-meta" data-end><span class="im-connection-meta">${item.meta}</span></div>` : nothing}
    ${trail ? html`<div class="fd-list-trail">${trail}</div>` : nothing}
    ${item.confirmation ?? nothing}
  </li>`;
}
