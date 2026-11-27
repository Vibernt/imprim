import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { t } from '../../../lib/i18n';
import { href } from '../../../lib/router';
import { menuTrigger, rowMenu, type RowAction } from '../../row-menu';
import { changeRoleForm, values } from './forms';
import { date, memberColumns, roleLabel, tableStatus, workspacePath, workspaceTable, type Invitation, type Member, type RecordPage } from './view';

interface MemberActions {
  active?: string;
  choose: (sub: string, trigger: string) => void;
  cancel: () => void;
  save: (sub: string, body: object) => void;
  remove: (member: Member, row: string) => void;
  isHeld: (row: string) => boolean;
}
const actionsColumn = () => ({ label: t('Actions'), actions: true });

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
  const rows = members.rows.length ? html`${repeat(members.rows, member => member.sub, member => {
    const edit = manage && (member.role !== 'owner' || (owner && workspace.owner_count > 1));
    const id = 'workspace-member-' + encodeURIComponent(member.sub);
    const held = actions.isHeld(id);
    const active = edit && !held && actions.active === member.sub;
    const menu: RowAction[] = [{ label: t('Change role'), run: () => actions.choose(member.sub, menuTrigger(id)) }];
    if (member.sub !== sub) menu.push({ label: t('Remove member'), danger: true, run: () => actions.remove(member, id) });
    return html`<tr ?data-expanded=${active} aria-busy=${held ? 'true' : nothing}>
      <td data-stack-title>${member.email}</td><td data-label=${columns[1].label}>${roleLabel(member.role)}</td>
      <td data-label=${columns[2].label}>${date(member.created)}</td>
      ${manage ? html`<td data-actions>${edit ? rowMenu(id, t('Actions for {email}', { email: member.email }), menu, busy || held, active)
        : nothing}</td>` : nothing}</tr>
      ${active ? html`<tr class="fd-table-detail"><td colspan=${headings.length}>
        ${changeRoleForm(member.role, owner, busy, event => {
          event.preventDefault();
          actions.save(member.sub, values(event));
        }, actions.cancel)}
      </td></tr>` : nothing}`;
  })}` : tableStatus(headings.length, t('No members on this page'));
  return workspaceTable(t('Members'), headings, rows, footer);
}

export function invitationTable(items: NonNullable<RecordPage['invitations']>, owner: boolean, busy: boolean,
  resend: (body: object) => void, revoke: (invite: Invitation, row: string) => void, isHeld: (row: string) => boolean) {
  const columns = [{ label: t('Email') }, { label: t('Role') }, { label: t('Expires') }, actionsColumn()];
  const rows = items.length ? html`${repeat(items, invite => invite.invitation_id, invite => {
    const id = 'workspace-invitation-' + encodeURIComponent(invite.invitation_id);
    const held = isHeld(id);
    const menu: RowAction[] = [];
    if (owner || invite.role !== 'owner') {
      menu.push({ label: t('Re-send'), run: () => resend({ email: invite.email, role: invite.role }) });
    }
    menu.push({ label: t('Revoke'), danger: true, run: () => revoke(invite, id) });
    return html`<tr aria-busy=${held ? 'true' : nothing}>
      <td data-stack-title>${invite.email}</td><td data-label=${columns[1].label}>${roleLabel(invite.role)}</td>
      <td data-label=${columns[2].label}>${date(invite.expires_at)}</td>
      <td data-actions>
        ${rowMenu(id, t('Actions for {email}', { email: invite.email }), menu, busy || held)}
      </td></tr>`;
  })}` : tableStatus(columns.length, t('No open invitations'));
  return workspaceTable(t('Open invitations'), columns, rows);
}
