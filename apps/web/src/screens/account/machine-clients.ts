import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { t } from '../../lib/i18n';
import { card } from '../page-layout';
import { confirmRowId } from '../confirm-row';
import { empty, when } from './access-view';
import { connectionRow, useTime } from './connection-row';

export interface MachineClient {
  client_id: string; name: string; app: string; workspace: string; resources: string[]; scopes: string[];
  created: number; expires_at: number; last_used: number | null;
  status: 'active' | 'expired' | 'disabled'; can_disable: boolean;
}

export function machineClients(clients: MachineClient[], pending: boolean, renew: (client: MachineClient) => void,
  disableQuestion: (client: MachineClient) => TemplateResult) {
  const title = t('Your machines');
  return card(title, clients.length ? html`<ul class="fd-list" data-divided aria-label=${title}>
    ${repeat(clients, client => client.client_id, client => {
      const id = `machine-${client.client_id}`;
      const confirmation = client.can_disable ? disableQuestion(client) : undefined;
      return connectionRow({ id, title: client.name, confirmation,
        lead: true, pending,
        description: [client.app, client.workspace, client.status === 'active' ? useTime(client.last_used) : undefined]
          .filter(Boolean).join(' · '),
        meta: client.status === 'active' ? undefined : client.status === 'expired' ? t('Expired') :
          client.can_disable ? t('Inactive') : t('Disabled'),
        actions: [
          ...(client.status === 'active' ? [{ label: t('Renew'), run: () => renew(client) }] : []),
          ...(client.can_disable ? [{ label: t('Disable'), danger: true, confirmRow: confirmRowId(id) }] : []),
        ],
        details: html`
          ${client.resources.map(resource => html`<code class="fd-mono-sm"><span class="im-breakable">${resource}</span></code>`)}
          ${client.scopes.length ? html`<div class="fd-row" data-wrap><span>${t('Scopes')}</span>
            ${client.scopes.map(scope => html`<code class="fd-mono-sm"><span class="im-breakable">${scope}</span></code>`)}</div>` : nothing}
          <p class="fd-small">${t('Approved {date}', { date: when(client.created) })}</p>
          <p class="fd-small">${t('Expires {date}', { date: when(client.expires_at) })}</p>`,
      });
    })}
  </ul>` : empty(t('No machines yet')), t('You answer for these machine clients.'));
}
