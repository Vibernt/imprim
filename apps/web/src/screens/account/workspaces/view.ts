import { html, nothing, type TemplateResult } from 'lit';
import { api, ApiError } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import { href, type View } from '../../../lib/router';

export const root = '/account/workspaces';
export const apiRoot = '/v1' + root;
export const workspacePath = (id: string) => root + '/' + encodeURIComponent(id);
export const memberSegment = (sub: string) => sub === '.' ? ':dot' : sub === '..' ? ':dotdot' : encodeURIComponent(sub);
export const roleIds = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = typeof roleIds[number];
export const roleLabel = (role: Role) => ({ owner: t('Owner'), admin: t('Admin'), member: t('Member'), viewer: t('Viewer') })[role];
export const kindLabel = (kind: Workspace['kind']) => kind === 'team' ? t('Team') : t('Personal');
export const date = (value: number) => new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium' }).format(value);

interface App { id: string; name: string; initiate_login_uri: string | null }
interface Product { product: string; apps: App[] }
export interface Workspace { workspace_id: string; name: string; kind: 'team' | 'personal'; members: number; products: Product[] }
export interface Member { sub: string; email: string; role: Role; created: number }
export interface Invitation { invitation_id: string; email: string; role: Role; expires_at: number }
export interface RecordPage {
  workspace: Workspace & { owner_count: number; version: number };
  role: Role;
  members: { rows: Member[]; after: string | null };
  invitations?: Invitation[];
}

export async function readWorkspace<T>(path: string): Promise<T | { notFound: true }> {
  try { return await api<T>(path); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return { notFound: true };
    throw error;
  }
}

export const notFound = (view: View) => html`<screen-not-found .view=${view}></screen-not-found>`;
export const back = () => html`<a class="fd-back" href=${href(root)}>
  <i data-icon="arrow-left" aria-hidden="true"></i><span>${t('Workspaces')}</span></a>`;

export function products(items: Product[]) {
  if (!items.length) return html`<span class="fd-muted">${t('No products yet')}</span>`;
  return html`<div class="fd-row" data-wrap data-gap="2">
    ${items.flatMap(({ product, apps }) => apps.length ? apps.map(app => app.initiate_login_uri
      ? html`<a class="fd-tag" data-im-document href=${app.initiate_login_uri}><span class="im-workspace-app-name" title=${app.name}>${app.name}</span></a>`
      : html`<span class="fd-tag" data-variant="soft"><span class="im-workspace-app-name" title=${app.name}>${app.name}</span></span>`)
      : [html`<span class="fd-tag" data-variant="soft"><span class="im-workspace-app-name" title=${product}>${product}</span></span>`])}
  </div>`;
}

type Column = { label: string; numeric?: boolean; actions?: boolean };
export const memberColumns = () => [{ label: t('Email') }, { label: t('Role') }, { label: t('Joined') }];

export function workspaceTable(label: string, columns: Column[], rows: TemplateResult | unknown[], footer: TemplateResult | typeof nothing = nothing, plain = false) {
  return html`<div class="fd-table-wrap" data-variant=${plain ? 'plain' : nothing}>
    <div class="fd-table-scroll" tabindex="0" role="region" aria-label=${label}>
      <table class="fd-table" data-stack data-wrap aria-label=${label}>
        <thead><tr>${columns.map(column => html`<th scope="col" ?data-num=${column.numeric} ?data-actions=${column.actions}>
          ${column.actions ? html`<span class="fd-sr-only">${column.label}</span>` : column.label}</th>`)}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${footer}
  </div>`;
}

export function skeletonRows(columns: Column[]) {
  return Array.from({ length: 3 }, () => html`<tr data-skeleton aria-hidden="true">
    ${columns.map(() => html`<td><span class="fd-table-skeleton" data-size="md"></span></td>`)}</tr>`);
}

export function tableStatus(columns: number, message: string, retry?: () => void, title?: string) {
  return html`<tr class="fd-table-state" data-state=${retry ? 'error' : nothing}><td colspan=${columns}>
    <div class="fd-table-empty" data-tone=${retry ? 'danger' : nothing} role=${retry ? 'alert' : nothing}>
      <p class="fd-table-empty-title">${title ?? message}</p>
      ${title ? html`<p class="fd-table-empty-text">${message}</p>` : nothing}
      ${retry ? html`<button class="fd-btn" type="button" @click=${retry}>${t('Try again')}</button>` : nothing}
    </div></td></tr>`;
}
