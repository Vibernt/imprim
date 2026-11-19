import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { overlays } from 'fire-design';
import { icon } from '../../lib/icon';
import { navigate, type View } from '../../lib/router';
import { text } from './core-fields';
import { AdminScreen, corePage } from './core-screen';
import { empty, mono, nextPage, table, when } from './core-view';

interface AuditRow { id: number; created: number; event: string; actor: string | null; target: string | null; detail: string }
const path = '/admin/audit';

class AuditScreen extends AdminScreen<{ audit: AuditRow[]; next: number | null }> {
  protected requestPath(view: View) { return '/admin/api/audit?' + view.query; }

  private changeFilter(name: string, value: string) {
    const query = new URLSearchParams(this.view.query);
    query.delete('before');
    if (value) query.set(name, value);
    else query.delete(name);
    void navigate(query.size ? path + '?' + query : path);
  }

  private filter(name: 'actor' | 'target', label: string) {
    const value = this.view.query.get(name) ?? '';
    const id = 'audit-filter-' + name;
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      overlays.closePopover(id);
      this.changeFilter(name, data.get(name) as string);
    };
    const clear = (event: CustomEvent<{ source: string; value: string | null }>) => {
      if (event.detail.source === 'filter' && event.detail.value === null) this.changeFilter(name, '');
    };
    return keyed(value, html`
      <div class="fd-filter" ?data-active=${Boolean(value)} data-default=${label} @fd:change=${clear}>
        <button class="fd-filter-trigger" type="button" data-fd-popover=${id} aria-expanded="false">
          <span class="fd-filter-label">${label}</span>
          <span class="fd-filter-value">${value || nothing}</span>
          <i class="fd-filter-chevron" data-icon="chevron-down" data-size="14" aria-hidden="true"></i>
        </button>
        <button class="fd-filter-clear" type="button" aria-label=${'Clear ' + label.toLowerCase()} ?hidden=${!value}>${icon('x')}</button>
      </div>
      <div class="fd-popover" id=${id} popover aria-label=${'Filter by ' + label.toLowerCase()}>
        <form class="fd-stack" data-gap="3" method="get" @submit=${submit}>
          ${text({ id: 'audit-' + name, label, name, value, mono: true })}
          <div class="fd-row"><button class="fd-btn" type="submit">Apply</button></div>
        </form>
      </div>`);
  }

  protected override render() {
    return corePage('Audit log', 'Every sign-in, grant and admin change, newest first. Rows cannot be edited.', html`
      <div class="fd-stack" data-gap="3">
        <div class="fd-filter-bar" role="group" aria-label="Filters">${this.filter('actor', 'Actor')}${this.filter('target', 'Target')}</div>
        ${this.content(({ audit, next }) => html`
          ${audit.length ? table('Audit log', ['Time', 'Event', 'Actor', 'Target', 'Detail'], audit.map(row => [
            when(row.created), mono(row.event), row.actor ? mono(row.actor) : 'System',
            row.target ? mono(row.target) : 'None', mono(row.detail || '{}'),
          ])) : empty('No events match', 'Clear the actor and target to see every event.')}
          ${nextPage(path, this.view.query, next)}
        `)}
      </div>`, { art: 'rain', busy: !this.data && !this.failure });
  }
}

customElements.define('screen-admin-audit', AuditScreen);
