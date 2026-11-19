import { html, nothing } from 'lit';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
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
    return this.page(t('Connected agents'), t('Agents act for you in an app. Revoke one to end its access.'), ({ agents, next }) => agents.length ? html`
      <div class="fd-table-wrap"><div class="fd-table-scroll">
        <table class="fd-table" aria-label=${t('Connected agents')}>
          <thead><tr><th scope="col">${t('Agent')}</th><th scope="col">${t('App')}</th><th scope="col">${t('Scopes')}</th>
            <th scope="col">${t('Last used')}</th><th scope="col">${t('Access')}</th></tr></thead>
          <tbody>${agents.map(a => html`<tr>
            <td><div class="fd-stack" data-gap="1"><span class="fd-label">${a.name}</span>
              ${a.host ? html`<span class="fd-mono-sm fd-muted">${a.host}</span>` : html`<span><span class="fd-badge" data-tone="warning">${t('Unverified')}</span></span>`}
            </div></td>
            <td><div class="fd-stack" data-gap="1"><span>${a.app}</span><span class="fd-small fd-muted">${t('Workspace: {workspace}', { workspace: a.workspace })}</span>
              <span class="fd-mono-sm fd-muted">${a.resource}</span></div></td>
            <td><div class="fd-row" data-wrap data-gap="1">${a.scopes.map(scope => html`<code class="fd-code">${scope}</code>`)}</div></td>
            <td><div class="fd-stack" data-gap="1"><span>${when(a.last_used)}</span><span class="fd-small fd-muted">${t('Connected {date}', { date: day(a.created) })}</span></div></td>
            <td>${this.access(a)}</td>
          </tr>`)}</tbody>
        </table>
      </div></div>
      ${next ? html`<div class="fd-row" data-justify="center"><a class="fd-btn" data-variant="ghost" href=${`/account/agents?before=${encodeURIComponent(next)}`}>${t('Older agents')}</a></div>` : nothing}`
      : empty(t('No agents connected'), t('Agents you approve to act in an app appear here.')));
  }
}
customElements.define('screen-agents', ScreenAgents);
