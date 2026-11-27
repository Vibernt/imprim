import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { api } from '../../lib/api';
import { icon } from '../../lib/icon';
import { t } from '../../lib/i18n';
import { card } from '../page-layout';
import { AccountScreen, post, success } from './account-screen';
import { empty } from './access-view';
import { agentRow, type Agent } from './agent-connection';
import { machineClients, type MachineClient } from './machine-clients';
import { agentLabelForm } from './agent-label-form';
import type { LoadingPreset } from '../loading';
import { RowConfirmations } from '../row-confirmations';
import { menuTrigger } from '../row-menu';

type Status = 'active' | 'ended';
interface GrantPage { agents: Agent[]; next: string | null }
interface Agents { active: GrantPage & { machine_clients: MachineClient[] }; ended: GrantPage & { total: number } }

class ScreenAgents extends AccountScreen<Agents> {
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'list', options: { rows: 4 } }];
  static override properties = { renaming: { state: true } };
  declare private renaming: string | undefined;
  private readonly confirmation = new RowConfirmations(this, () => t('The request could not be completed.'));
  private get locked() { return this.pending || this.confirmation.pending; }
  private cursor = { active: '', ended: '' };

  protected override async read() {
    const path = (status: Status) => `/v1/account/agents?${new URLSearchParams({ status, before: this.cursor[status] })}`;
    const [active, ended] = await Promise.all([api<Agents['active']>(path('active')), api<Agents['ended']>(path('ended'))]);
    return { active, ended };
  }

  private async rename(id?: string) {
    const previous = this.renaming;
    this.confirmation.clear();
    this.renaming = id;
    await this.updateComplete;
    const focus = id ? `agent-label-${id}` : previous ? menuTrigger(`agent-${previous}`) : '';
    if (focus) this.querySelector<HTMLElement>(`#${CSS.escape(focus)}`)?.focus();
  }

  private async saveLabel(agent: Agent, event: SubmitEvent) {
    event.preventDefault();
    const label = new FormData(event.currentTarget as HTMLFormElement).get('label');
    let saved = false;
    await this.mutate(async () => {
      await post('agents/label', { grant_id: agent.id, label });
      if (!this.isConnected) return;
      success(t('Connection name saved'));
      await this.load(false);
      saved = true;
    });
    if (saved) await this.rename();
  }

  private revokeQuestion(agent: Agent) {
    return this.confirmation.view({
      id: `agent-${agent.id}`, text: t('Revoke access for {name}?', { name: agent.label || agent.name }),
      action: t('Revoke'), cancelLabel: t('Cancel'),
      opened: () => { this.renaming = undefined; },
      request: () => post('agents/revoke', { grant_id: agent.id }),
      done: async () => {
        success(t('Agent revoked'));
        this.cursor.ended = '';
        await this.load(false);
      },
    });
  }

  private async renewMachine(client: MachineClient) {
    this.confirmation.clear();
    await post('machine-clients/renew', { client_id: client.client_id });
    if (!this.isConnected) return;
    success(t('Machine renewed'));
    await this.load(false);
  }

  private disableQuestion(client: MachineClient) {
    return this.confirmation.view({
      id: `machine-${client.client_id}`, text: t('{name} loses access to this workspace.', { name: client.name }),
      action: t('Disable machine'), cancelLabel: t('Cancel'),
      phrase: { value: client.client_id, label: t('Machine client ID'), trim: true,
        rule: t('Type {id} to confirm.', { id: client.client_id }) },
      opened: () => { this.renaming = undefined; },
      request: () => post('machine-clients/disable', { client_id: client.client_id }),
      done: async () => {
        success(t('Machine disabled'));
        await this.load(false);
      },
    });
  }

  private pagination(status: Status, next: string | null) {
    const go = (cursor: string) => this.mutate(async () => {
      this.renaming = undefined;
      this.confirmation.clear();
      this.cursor[status] = cursor;
      await this.load(false);
    });
    return next || this.cursor[status] ? html`<div class="fd-row" data-wrap>
      <button class="fd-btn" data-variant="ghost" type="button" ?disabled=${this.locked || !this.cursor[status]}
        @click=${() => go('')}>${t('First page')}</button>
      <button class="fd-btn" data-variant="ghost" type="button" ?disabled=${this.locked || !next}
        @click=${() => next && go(next)}>${t('Older agents')}</button>
    </div>` : nothing;
  }

  private connections(label: string, agents: Agent[]) {
    return html`<ul class="fd-list" data-divided aria-label=${label}>${repeat(agents, agent => agent.id, agent => {
      const form = this.renaming === agent.id ? agentLabelForm(agent.id, agent.label, this.locked,
        event => this.saveLabel(agent, event), () => this.rename()) : nothing;
      return agentRow(agent, this.locked, () => this.rename(agent.id), form,
        agent.status === 'active' ? this.revokeQuestion(agent) : undefined);
    })}</ul>`;
  }

  protected override render() {
    const activeTitle = t('Active connections');
    return this.page(t('Agents'), t('Agents act for you in an app. Revoke one to end its access.'), ({ active, ended }) => {
      const endedTitle = t('Ended connections ({count})', { count: ended.total });
      return html`
        ${card(activeTitle, html`
          ${active.agents.length ? this.connections(activeTitle, active.agents) :
            empty(t('No agents connected'), t('Agents appear here after you approve one from an app.'))}
          ${this.pagination('active', active.next)}
          ${ended.total ? html`<div class="fd-accordion" data-variant="card">
            <details class="fd-accordion-item">
              <summary class="fd-accordion-trigger"><span>${endedTitle}</span>${icon('chevron-down')}</summary>
              <div class="fd-accordion-panel"><div class="fd-accordion-inner">
                ${this.connections(endedTitle, ended.agents)}
                ${this.pagination('ended', ended.next)}
              </div></div>
            </details>
          </div>` : nothing}`)}
        ${machineClients(active.machine_clients, this.locked,
          client => this.mutate(() => this.renewMachine(client)), client => this.disableQuestion(client))}`;
    });
  }
}

customElements.define('screen-agents', ScreenAgents);
