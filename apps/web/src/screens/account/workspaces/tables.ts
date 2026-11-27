import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { t } from '../../../lib/i18n';
import { href } from '../../../lib/router';
import { changeRoleForm, confirmAction, values } from './forms';
import { date, memberColumns, roleLabel, tableStatus, workspacePath, workspaceTable, type RecordPage } from './view';

type MemberAction = 'role' | 'remove';
interface MemberActions {
  active?: { mode: MemberAction; sub: string };
  choose: (mode: MemberAction, sub: string, trigger: string) => void;
  cancel: () => void;
  save: (mode: MemberAction, sub: string, body?: object) => void;
}
const actionsColumn = () => ({ label: t('Actions'), actions: true });

const menuButton = (id: string, label: string, pending: boolean) => html`
  <button class="fd-btn" id=${id + '-trigger'} type="button" data-variant="ghost" data-size="sm" data-icon-only
    data-fd-menu=${id} aria-haspopup="menu" aria-expanded="false" aria-label=${label} ?disabled=${pending}>
    <i data-icon="ellipsis" aria-hidden="true"></i>
  </button>`;

export function memberTable(data: RecordPage, sub: string, after: string | null, busy: boolean, actions: MemberActions) {
  const { workspace, members, role } = data;
  const owner = role === 'owner', manage = workspace.kind === 'team' && (owner || role === 'admin');
  const columns = memberColumns();
  const headings = manage ? [...columns, actionsColumn()] : columns;
  const url = workspacePath(workspace.workspace_id);
  const footer = after || members.after ? html`<div class="fd-table-foot">
    <nav class="fd-pagination" aria-label=${t('Member pages')}><div class="fd-pagination-pages">
      ${after ? html`<a class="fd-btn" data-variant="ghost" href=${href(url)}>${t('First page')}</a>` : nothing}
      ${members.after ? html`<a class="fd-btn" data-variant="ghost" href=${href(url + '?' + new URLSearchParams({ after: members.after }))}>${t('Next page')}</a>` : nothing}
    </div></nav>
  </div>` : nothing;
  const rows = members.rows.length ? html`${repeat(members.rows, member => member.sub, (member, index) => {
    const edit = manage && (member.role !== 'owner' || (owner && workspace.owner_count > 1));
    const id = 'im-workspace-member-' + index;
    const active = edit && actions.active?.sub === member.sub ? actions.active.mode : undefined;
    return html`<tr ?data-expanded=${Boolean(active)}>
      <td data-stack-title>${member.email}</td><td data-label=${columns[1].label}>${roleLabel(member.role)}</td>
      <td data-label=${columns[2].label}>${date(member.created)}</td>
      ${manage ? html`<td data-actions>${edit ? html`
        ${menuButton(id, t('Actions for {email}', { email: member.email }), busy)}
        <div class="fd-menu" id=${id} popover role="menu" aria-label=${t('Actions')}>
          <button class="fd-menu-item" role="menuitem" type="button" @click=${() => actions.choose('role', member.sub, id + '-trigger')}>${t('Change role')}</button>
          ${member.sub === sub ? nothing : html`<button class="fd-menu-item" data-tone="danger" role="menuitem" type="button"
            @click=${() => actions.choose('remove', member.sub, id + '-trigger')}>${t('Remove member')}</button>`}
        </div>` : nothing}</td>` : nothing}</tr>
      ${active ? html`<tr class="fd-table-detail"><td colspan=${headings.length}>
        ${active === 'role' ? changeRoleForm(member.role, owner, busy, event => {
          event.preventDefault();
          actions.save('role', member.sub, values(event));
        }, actions.cancel) : confirmAction(member.email, t('Remove member'), busy, () => actions.save('remove', member.sub), actions.cancel)}
      </td></tr>` : nothing}`;
  })}` : tableStatus(headings.length, t('No members on this page'));
  return workspaceTable(t('Members'), headings, rows, footer);
}

export function invitationTable(items: NonNullable<RecordPage['invitations']>, owner: boolean, busy: boolean,
  resend: (body: object) => void, revoke: (id: string) => void) {
  const columns = [{ label: t('Email') }, { label: t('Role') }, { label: t('Expires') }, actionsColumn()];
  const rows = items.length ? html`${repeat(items, invite => invite.invitation_id, (invite, index) => {
    const id = 'im-workspace-invitation-' + index;
    return html`<tr>
      <td data-stack-title>${invite.email}</td><td data-label=${columns[1].label}>${roleLabel(invite.role)}</td>
      <td data-label=${columns[2].label}>${date(invite.expires_at)}</td>
      <td data-actions>
        ${menuButton(id, t('Actions for {email}', { email: invite.email }), busy)}
        <div class="fd-menu" id=${id} popover role="menu" aria-label=${t('Actions')}>
          ${owner || invite.role !== 'owner' ? html`<button class="fd-menu-item" role="menuitem" type="button"
            @click=${() => resend({ email: invite.email, role: invite.role })}>${t('Re-send')}</button>` : nothing}
          <button class="fd-menu-item" data-tone="danger" role="menuitem" type="button"
            @click=${() => revoke(invite.invitation_id)}>${t('Revoke')}</button>
        </div>
      </td></tr>`;
  })}` : tableStatus(columns.length, t('No open invitations'));
  return workspaceTable(t('Open invitations'), columns, rows);
}
