import { html, nothing, type TemplateResult } from 'lit';
import { icon } from '../../lib/icon';
import { t } from '../../lib/i18n';
import { initial, when } from './access-view';

export const useTime = (value: number | null) => value === null ? t('Not used yet') : t('Used {date}', { date: when(value) });

interface Item { id: string; title: string; description: string; meta: string; details: TemplateResult;
  form?: TemplateResult | typeof nothing; badge?: string; actions?: { label: string; run: () => void; danger?: boolean }[]; pending?: boolean }

export function connectionRow(item: Item) {
  const menu = `connection-menu-${item.id}`;
  return html`<li class="fd-list-row">
    <span class="fd-list-lead" aria-hidden="true"><span class="fd-tile" data-size="36" data-tone="accent">${initial(item.title)}</span></span>
    <div class="fd-list-body">
      <div class="fd-row" data-wrap data-gap="2"><span class="fd-list-title">${item.title}</span>
        ${item.badge ? html`<span class="fd-badge" data-tone="warning">${item.badge}</span>` : nothing}</div>
      <span class="fd-list-desc"><span class="im-breakable">${item.description}</span></span>
      <details class="fd-disclosure">
        <summary class="fd-disclosure-trigger"><span>${t('Details')}</span>${icon('chevron-down')}</summary>
        <div class="fd-disclosure-panel"><div class="fd-disclosure-inner fd-stack" data-gap="1">${item.details}</div></div>
      </details>
      ${item.form}
    </div>
    <div class="fd-list-meta" data-end><span class="im-connection-meta">${item.meta}</span></div>
    ${item.actions?.length ? html`<div class="fd-list-trail">
      <button class="fd-btn" data-variant="ghost" data-size="sm" data-icon-only type="button" data-fd-menu=${menu}
        id=${`connection-more-${item.id}`} aria-label=${t('More actions for {name}', { name: item.title })} ?disabled=${item.pending}>${icon('ellipsis')}</button>
      <div class="fd-menu" id=${menu} popover role="menu">${item.actions.map(action => html`
        <button class="fd-menu-item" role="menuitem" type="button" data-tone=${action.danger ? 'danger' : nothing}
          @fd:select=${action.run}>${action.label}</button>`)}</div>
    </div>` : nothing}
  </li>`;
}
