import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { keyed } from 'lit/directives/keyed.js';
import { api } from '../../lib/api';
import { icon } from '../../lib/icon';
import { t } from '../../lib/i18n';
import { card } from '../page-layout';
import { AccountScreen, post, success } from './account-screen';
import { empty } from './access-view';
import { agentRow, type Agent } from './agent-connection';
import { confirmDisableMachine, machineClients, type MachineClient } from './machine-clients';
import { agentLabelForm, confirmRevokeAgent } from './agent-label-form';

type Status = 'active' | 'ended';
interface GrantPage { agents: Agent[]; next: string | null }
interface Agents { active: GrantPage & { machine_clients: MachineClient[] }; ended: GrantPage & { total: number } }
type Review = { kind: 'rename' | 'revoke'; agent: Agent } | { kind: 'disable'; client: MachineClient };

class ScreenAgents extends AccountScreen<Agents> {
  static override properties = { review: { state: true } };
  declare private review: Review | undefined;
  private cursor = { active: '', ended: '' };

  protected override async read() {
    const path = (status: Status) => `/v1/account/agents?${new URLSearchParams({ status, before: this.cursor[status] })}`;
    const [active, ended] = await Promise.all([api<Agents['active']>(path('active')), api<Agents['ended']>(path('ended'))]);
    return { active, ended };
  }

  private async select(review?: Review) {
    const previous = this.review;
    this.review = review;
    await this.updateComplete;
    const focus = review?.kind === 'rename' ? `agent-label-${review.agent.id}` :
      review?.kind === 'revoke' ? `agent-revoke-cancel-${review.agent.id}` : review?.kind === 'disable' ? 'confirm-machine' :
      previous?.kind === 'disable' ? `connection-more-machine-${previous.client.client_id}` :
      previous ? `connection-more-agent-${previous.agent.id}` : '';
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
    if (saved) await this.select();
  }

  private revoke(agent: Agent) {
    return this.mutate(async () => {
      await post('agents/revoke', { grant_id: agent.id });
      if (!this.isConnected) return;
      success(t('Agent revoked'));
      this.review = undefined;
      this.cursor.ended = '';
      await this.load(false);
      await this.updateComplete;
      this.querySelector<HTMLElement>('.fd-accordion-trigger')?.focus();
    });
  }

  private changeMachine(client: MachineClient, action: 'renew' | 'disable') {
    return this.mutate(async () => {
      await post('machine-clients/' + action, { client_id: client.client_id });
      if (!this.isConnected) return;
      if (action === 'disable') this.review = undefined;
      success(action === 'renew' ? t('Machine renewed') : t('Machine disabled'));
      await this.load(false);
    });
  }

  private pagination(status: Status, next: string | null) {
    const go = (cursor: string) => this.mutate(async () => {
      this.review = undefined;
      this.cursor[status] = cursor;
      await this.load(false);
    });
    return next || this.cursor[status] ? html`<div class="fd-row" data-wrap>
      <button class="fd-btn" data-variant="ghost" type="button" ?disabled=${this.pending || !this.cursor[status]}
        @click=${() => go('')}>${t('First page')}</button>
      <button class="fd-btn" data-variant="ghost" type="button" ?disabled=${this.pending || !next}
        @click=${() => next && go(next)}>${t('Older agents')}</button>
    </div>` : nothing;
  }

  private connections(label: string, agents: Agent[]) {
    const review = this.review;
    return html`<ul class="fd-list" data-divided aria-label=${label}>${repeat(agents, agent => agent.id, agent => {
      const selected = review && review.kind !== 'disable' && review.agent.id === agent.id;
      const form = selected && review.kind === 'rename' ? agentLabelForm(agent.id, agent.label, this.pending,
        event => this.saveLabel(agent, event), () => this.select()) : selected && review.kind === 'revoke' ?
        confirmRevokeAgent(agent.id, agent.label || agent.name, this.pending, () => this.revoke(agent), () => this.select()) : nothing;
      return agentRow(agent, this.pending, () => this.select({ kind: 'rename', agent }), () => this.select({ kind: 'revoke', agent }), form);
    })}</ul>`;
  }

  protected override render() {
    const activeTitle = t('Active connections');
    const review = this.review;
    return this.page(t('Connected agents'), t('Agents act for you in an app. Revoke one to end its access.'), ({ active, ended }) => {
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
        ${machineClients(active.machine_clients, this.pending, client => this.changeMachine(client, 'renew'), client => this.select({ kind: 'disable', client }))}
        ${review?.kind === 'disable' ? keyed(review.client.client_id, confirmDisableMachine(review.client, this.pending,
          () => this.changeMachine(review.client, 'disable'), () => this.select())) : nothing}`;
    });
  }
}

customElements.define('screen-agents', ScreenAgents);
