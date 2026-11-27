import { html } from 'lit';
import { navigate, type View } from '../../lib/router';
import { AdminScreen, corePage } from './core-screen';
import { mono, nextPage, table, when } from './core-view';
import { eventLabel } from './audit-events';
import { auditFilters } from './audit-filters';
import type { LoadingPreset } from '../loading';

interface AuditRow {
  id: number; created: number; event: string; detail: string | null;
  actor: string | null; actor_label: string | null; target: string | null; target_label: string | null;
}
const path = '/admin/audit';

const subject = (id: string | null, label: string | null) => {
  if (!id) return '—';
  return label ? html`<span tabindex="0" data-fd-tooltip=${id}>${label}</span>` : mono(id);
};

const detail = (value: string | null) => {
  const text = value?.trim();
  return text && !/^(?:\{\s*\}|\[\s*\]|null)$/.test(text)
    ? html`<code class="fd-code im-breakable">${text}</code>` : '—';
};

class AuditScreen extends AdminScreen<{ audit: AuditRow[]; next: number | null }> {
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'table', options: { rows: 5, cols: 5 } }];
  protected requestPath(view: View) { return '/admin/api/audit?' + view.query; }

  private changeFilters = (filters: Record<string, string>) => {
    const query = new URLSearchParams(this.view.query);
    query.delete('before');
    for (const [name, value] of Object.entries(filters)) {
      if (value) query.set(name, value);
      else query.delete(name);
    }
    void navigate(query.size ? path + '?' + query : path);
  };

  protected override render() {
    return corePage('Audit log', 'Sign-ins, grants and admin changes, newest first.', html`
      <div class="fd-stack" data-gap="3">
        ${auditFilters(this.view.query, this.changeFilters)}
        ${this.content(({ audit, next }) => html`
          ${table('Audit log', ['Time', 'Event', 'Actor', 'Target', 'Detail'], audit.map(row => [
            when(row.created), eventLabel(row.event), subject(row.actor, row.actor_label),
            subject(row.target, row.target_label), detail(row.detail),
          ]), ['No events match', 'Clear a filter to see more events.'], { title: 'Event' })}
          ${nextPage(path, this.view.query, next)}
        `)}
      </div>`, { busy: !this.data && !this.failure });
  }
}

customElements.define('screen-admin-audit', AuditScreen);
