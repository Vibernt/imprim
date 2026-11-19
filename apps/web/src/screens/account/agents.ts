import { html, nothing } from 'lit';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { card, setting } from '../page-layout';
import { AccountScreen, post, success } from './account-screen';
import { day, when, empty } from './access-view';

interface Agent {
  id: string; name: string; app: string; host: string | null; workspace: string; resource: string; scopes: string[];
  last_used: number | null; created: number; status: 'revoked' | 'expired' | 'active';
}
interface Agents { agents: Agent[]; next: string | null }

class ScreenAgents extends AccountScreen<Agents> {
  private queryString = '';

  set query(query: URLSearchParams) {
    const before = query.toString();
    if (before === this.queryString) return;
    this.queryString = before;
    if (this.isConnected) void this.load();
  }

  protected override read() {
    return api<Agents>(`/v1/account/agents?${this.queryString}`);
  }

  private revoke = (agent: Agent) => this.mutate(async () => {
    await post('agents/revoke', { grant_id: agent.id });
    if (!this.isConnected) return;
    success(t('Agent revoked'));
    await this.load(false);
  });

  private access(agent: Agent) {
    if (agent.status === 'revoked') return html`<span class="fd-status">${t('Revoked')}</span>`;
    if (agent.status === 'expired') return html`<span class="fd-status" data-tone="warning">${t('Expired')}</span>`;
    return html`<button class="fd-btn" data-variant="danger-soft" data-size="sm" type="button"
      aria-label=${t('Revoke {name}', { name: agent.name })} ?disabled=${this.pending} @click=${() => this.revoke(agent)}>${t('Revoke')}</button>`;
  }

  protected override render() {
    return this.page(t('Connected agents'), t('Agents act for you in an app. Revoke one to end its access.'), ({ agents, next }) =>
      card(t('Agents'), agents.length ? html`
        <div role="group" aria-label=${t('Connected agents')}>
          ${agents.map(agent => setting(
            html`<span class="fd-sr-only">${t('Agent')} </span><span class="fd-kv-value" data-plain>${agent.name}</span>`,
            html`<div class="fd-stack" data-gap="1">
              <div class="fd-kv-value">${agent.host ? html`<code class="fd-code">${agent.host}</code>` : html`<span class="fd-badge" data-tone="warning">${t('Unverified')}</span>`}</div>
              <div class="fd-kv-value" data-plain>${t('App')} · ${agent.app} · ${t('Workspace: {workspace}', { workspace: agent.workspace })}</div>
              <div class="fd-kv-value"><code class="fd-code">${agent.resource}</code></div>
              <div class="fd-row" data-wrap data-gap="1"><span>${t('Scopes')}</span>
                ${agent.scopes.map(scope => html`<code class="fd-code fd-kv-value">${scope}</code>`)}
              </div>
              <div>${t('Last used')} · ${when(agent.last_used)}</div>
              <div>${t('Connected {date}', { date: day(agent.created) })}</div>
            </div>`, html`<div class="fd-row" role="group" aria-label=${t('Access')}>${this.access(agent)}</div>`))}
        </div>
        ${next ? html`<div class="fd-row" data-justify="center">
          <a class="fd-btn" data-variant="ghost" href=${`/account/agents?before=${encodeURIComponent(next)}`}>${t('Older agents')}</a>
        </div>` : nothing}`
      : empty(t('No agents connected'), t('Agents you approve to act in an app appear here.'))));
  }
}
customElements.define('screen-agents', ScreenAgents);
