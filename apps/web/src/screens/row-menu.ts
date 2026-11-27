import { html, nothing } from 'lit';
import { icon } from '../lib/icon';

type Item = { label: string; name?: string; danger?: boolean };
export type RowAction = Item & (
  { href: string; document?: boolean } | { run: () => void } | { confirmRow: string } |
  { disabledReason: string; reasonId?: string }
);

export const menuTrigger = (id: string) => `im-more-${id}`;

export function rowMenu(id: string, label: string, actions: RowAction[], disabled = false, expanded = false) {
  if (!actions.length) return html``;
  const menu = `im-menu-${id}`;
  return html`
    <button class="fd-btn" data-variant="ghost" data-size="sm" data-icon-only type="button"
      data-fd-menu=${menu} data-placement="bottom-end" id=${menuTrigger(id)}
      aria-label=${label} aria-expanded=${String(expanded)} ?disabled=${disabled}>${icon('ellipsis')}</button>
    <div class="fd-menu" id=${menu} popover role="menu" aria-label=${label}
      @fd:close=${(event: Event) => {
        if (expanded && event.target === event.currentTarget) {
          (event.currentTarget as HTMLElement).previousElementSibling?.setAttribute('aria-expanded', 'true');
        }
      }}>
      ${actions.map((action, index) => html`
        ${action.danger && index && !actions[index - 1].danger ? html`<hr class="fd-menu-sep">` : nothing}
        ${'href' in action ? html`
          <a class="fd-menu-item" role="menuitem" href=${action.href} ?data-im-document=${action.document}
            data-tone=${action.danger ? 'danger' : nothing} aria-label=${action.name ?? nothing}>
            <span class="fd-menu-item-label">${action.label}</span>
          </a>` : html`
          <button class="fd-menu-item" role="menuitem" type="button" data-tone=${action.danger ? 'danger' : nothing}
            aria-label=${action.name ?? ('disabledReason' in action ? action.label : nothing)}
            data-fd-confirm-row=${'confirmRow' in action ? action.confirmRow : nothing}
            aria-disabled=${'disabledReason' in action ? 'true' : nothing}
            aria-describedby=${'disabledReason' in action ? action.reasonId ?? nothing : nothing}
            @fd:select=${'run' in action ? action.run : nothing}>
            <span class="fd-menu-item-label">${action.label}${'disabledReason' in action
              ? html`<span class="fd-menu-item-desc">${action.disabledReason}</span>` : nothing}</span>
          </button>`}`)}
    </div>`;
}
