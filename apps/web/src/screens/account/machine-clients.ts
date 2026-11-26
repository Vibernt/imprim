import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { t } from '../../lib/i18n';
import { card } from '../page-layout';
import { empty, when } from './access-view';
import { connectionRow, useTime } from './connection-row';

export interface MachineClient {
  client_id: string; name: string; app: string; workspace: string; resources: string[]; scopes: string[];
  created: number; expires_at: number; last_used: number | null;
  status: 'active' | 'expired' | 'disabled'; can_disable: boolean;
}

export function machineClients(clients: MachineClient[], pending: boolean, renew: (client: MachineClient) => void,
  review: (client: MachineClient) => void) {
  const title = t('Machines you’re accountable for');
  return card(title, clients.length ? html`<ul class="fd-list" data-divided aria-label=${title}>
    ${repeat(clients, client => client.client_id, client => connectionRow({ id: `machine-${client.client_id}`, title: client.name,
      description: [client.app, client.workspace].filter(Boolean).join(' · '), pending,
      meta: client.status === 'active' ? useTime(client.last_used) : client.status === 'expired' ? t('Expired') :
        client.can_disable ? t('Inactive') : t('Disabled'),
      actions: [
        ...(client.status === 'active' ? [{ label: t('Renew'), run: () => renew(client) }] : []),
        ...(client.can_disable ? [{ label: t('Disable'), run: () => review(client), danger: true }] : []),
      ],
      details: html`
        ${client.resources.map(resource => html`<code class="fd-mono-sm"><span class="im-breakable">${resource}</span></code>`)}
        ${client.scopes.length ? html`<div class="fd-row" data-wrap><span>${t('Scopes')}</span>
          ${client.scopes.map(scope => html`<code class="fd-mono-sm"><span class="im-breakable">${scope}</span></code>`)}</div>` : nothing}
        <p class="fd-small">${t('Approved {date}', { date: when(client.created) })}</p>
        <p class="fd-small">${t('Expires {date}', { date: when(client.expires_at) })}</p>`,
    }))}
  </ul>` : empty(t('No machines yet')));
}

export function confirmDisableMachine(client: MachineClient, pending: boolean, disable: () => void, cancel: () => void) {
  function submit(event: SubmitEvent) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!pending && String(new FormData(event.currentTarget as HTMLFormElement).get('confirm_machine')).trim() === client.client_id) disable();
  }
  return card(t('Disable machine?'), html`
    <form class="fd-confirm-inline" method="post" data-fd-confirm-inline data-confirm=${client.client_id} @submit=${submit}>
      <div class="fd-field">
        <label class="fd-field-label" for="confirm-machine">${t('Machine client ID')}</label>
        <input class="fd-input" id="confirm-machine" name="confirm_machine" data-fd-confirm-input autocomplete="off"
          spellcheck="false" aria-describedby="confirm-machine-rule" required ?disabled=${pending}>
        <p class="fd-confirm-inline-rule" id="confirm-machine-rule" data-fd-confirm-rule
          >${t('Type {id} to confirm.', { id: client.client_id })}</p>
      </div>
      <div class="fd-form-actions">
        <button class="fd-btn" data-variant="ghost" type="button" ?disabled=${pending} @click=${cancel}>${t('Cancel')}</button>
        <button class="fd-btn" data-variant="danger" type="submit" data-fd-confirm-submit>${t('Disable machine')}</button>
      </div>
    </form>`, t('{name} loses access to this workspace.', { name: client.name }));
}
