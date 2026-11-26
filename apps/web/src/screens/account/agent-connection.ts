import { html, nothing, type TemplateResult } from 'lit';
import { t } from '../../lib/i18n';
import { when } from './access-view';
import { connectionRow, useTime } from './connection-row';

export interface Agent {
  id: string; name: string; app: string; host: string | null; resource: string;
  scopes: { code: string; label: string | null }[];
  workspace_name: string | null; resource_name: string | null;
  label: string | null; approved_device: string | null; approved_location: string | null;
  last_used: number | null; created: number; expires_at: number; status: 'revoked' | 'expired' | 'active';
  ended_at: number | null; ended_reason: string | null;
}

function ended(agent: Agent) {
  const date = when(agent.ended_at);
  if (agent.ended_reason === 'agent_replaced') return t('Replaced {date}', { date });
  if (agent.ended_reason === 'workspace_access_ended') return t('Workspace access ended {date}', { date });
  return agent.status === 'expired' ? t('Expired {date}', { date }) : t('Revoked {date}', { date });
}

export function agentRow(agent: Agent, pending: boolean, rename: () => void, revoke: () => void, form: TemplateResult | typeof nothing) {
  const device = [agent.approved_device, agent.approved_location].filter(Boolean).join(', ');
  const date = when(agent.created);
  return connectionRow({ id: `agent-${agent.id}`, title: agent.label || agent.name,
    badge: agent.host ? undefined : t('Unverified'), pending, form,
    description: [agent.app, agent.workspace_name, device].filter(Boolean).join(' · '),
    meta: agent.status === 'active' ? useTime(agent.last_used) : ended(agent),
    actions: agent.status === 'active' ? [{ label: t('Rename'), run: rename }, { label: t('Revoke'), run: revoke, danger: true }] : [],
    details: html`
      ${agent.label ? html`<span>${agent.name}</span>` : nothing}
      ${agent.host ? html`<code class="fd-mono-sm"><span class="im-breakable">${agent.host}</span></code>` : nothing}
      ${agent.resource_name ? html`<span>${agent.resource_name}</span>` : nothing}
      <code class="fd-mono-sm"><span class="im-breakable">${agent.resource}</span></code>
      ${agent.scopes.length ? html`<p class="fd-small">${t('Permissions')}</p>
        <ul>${agent.scopes.map(scope => html`<li>${scope.label} <code class="fd-mono-sm"><span class="im-breakable">${scope.code}</span></code></li>`)}</ul>` : nothing}
      <p class="fd-small">${device ? t('Approved {date} on {device}', { date, device }) : t('Approved {date}', { date })}</p>
      <p class="fd-small">${t('Connected {date}', { date })}</p>
      <p class="fd-small">${t('Expires {date}', { date: when(agent.expires_at) })}</p>`,
  });
}
