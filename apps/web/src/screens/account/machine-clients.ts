import { html, nothing } from 'lit';
import { t } from '../../lib/i18n';
import { card, setting } from '../page-layout';
import { day, empty, when } from './access-view';

export interface MachineClient {
  client_id: string; name: string; app: string; workspace: string; resources: string[]; scopes: string[];
  created: number; expires_at: number; last_used: number | null;
  status: 'active' | 'expired' | 'disabled'; can_disable: boolean;
}

export function machineClients(clients: MachineClient[], pending: boolean, renew: (client: MachineClient) => void,
  review: (client: MachineClient) => void) {
  const title = t('Machines you’re accountable for');
  return card(title, clients.length ? html`<div role="group" aria-label=${title}>
    ${clients.map(client => setting(client.name, html`<div class="fd-stack" data-gap="1">
      <div class="fd-kv-value" data-plain>${t('App')} · ${client.app} · ${t('Workspace: {workspace}', { workspace: client.workspace })}</div>
      <div class="fd-stack" data-gap="1">${client.resources.map(resource => html`<code class="fd-code fd-kv-value">${resource}</code>`)}</div>
      <div class="fd-row" data-wrap data-gap="1"><span>${t('Scopes')}</span>
        ${client.scopes.map(scope => html`<code class="fd-code fd-kv-value">${scope}</code>`)}
      </div>
      <div>${t('Approved {date}', { date: day(client.created) })}</div>
      <div>${t('Expires {date}', { date: day(client.expires_at) })}</div>
      <div>${t('Last used')} · ${when(client.last_used)}</div>
    </div>`, html`<div class="fd-row" data-wrap data-gap="2">
      ${client.status === 'active' ? html`<span class="fd-status" data-tone="success">${t('Active')}</span>`
        : client.status === 'expired' ? html`<span class="fd-status" data-tone="warning">${t('Expired')}</span>`
        : html`<span class="fd-status">${client.can_disable ? t('Inactive') : t('Disabled')}</span>`}
      ${client.status === 'active' ? html`<button class="fd-btn" data-variant="outline" data-size="sm" type="button"
        aria-label=${t('Renew {name}', { name: client.name })} ?disabled=${pending} @click=${() => renew(client)}>${t('Renew')}</button>` : nothing}
      ${client.can_disable ? html`<button class="fd-btn" data-variant="danger-soft" data-size="sm" type="button"
        id=${'disable-' + client.client_id} aria-label=${t('Disable {name}', { name: client.name })}
        ?disabled=${pending} @click=${() => review(client)}>${t('Disable')}</button>` : nothing}
    </div>`))}
  </div>` : empty(t('No machines yet'), t('Machines you approve for a workspace appear here.')));
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
