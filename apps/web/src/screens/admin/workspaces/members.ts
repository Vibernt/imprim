import { html, nothing } from 'lit';
import { card, inlineError } from '../../page-layout';
import { rowMenu } from '../../row-menu';
import { cap, field, table, when } from '../realm-ui';
import { roleField } from './forms';
import type { Controls, Workspace } from './types';

type Member = Workspace['members'][number];
export const memberMenuId = (id: string) => 'workspace-member-' + id;
export const memberRoleId = (id: string) => 'member-role-' + id;
const inviteMenuId = (id: string) => 'workspace-invitation-' + id;

export function members(workspace: Workspace, controls: Controls) {
  const editable = workspace.editable && workspace.kind === 'team';
  const headers = editable ? ['Email', 'Role', 'Actions'] : ['Email', 'Role'];
  return card('Members', html`
    ${workspace.can_invite ? inviteForm(workspace, controls) : nothing}
    ${table('Members', headers, workspace.members.map(member => {
      const id = memberMenuId(member.id);
      const busy = controls.busy(id);
      const action = member.manageable ? rowMenu(id, 'More actions for ' + member.email, [
        { label: 'Change role', run: () => controls.openRole(member.id) },
        { label: 'Remove', danger: true, run: () => controls.hold(id, 'Removing ' + member.email, 'remove-member', { sub: member.id }) },
      ], controls.pending || busy || controls.role === member.id) : '—';
      return {
        id, busy, cells: [member.email, cap(member.role), ...(editable ? [action] : [])],
        detail: controls.role === member.id && member.manageable ? roleForm(workspace, member, controls) : undefined,
      };
    }), ['No members', 'Members appear after accepting an invitation.'], { emptyOnly: true })}
    ${workspace.invitations.length ? invitations(workspace, controls) : nothing}
  `);
}

function roleForm(workspace: Workspace, member: Member, controls: Controls) {
  return html`<form class="fd-form" method="post" @submit=${(event: SubmitEvent) => controls.submit('role', event)}>
    <fieldset class="fd-row" data-align="end" data-wrap data-gap="3" ?disabled=${controls.pending}>
      <legend class="fd-sr-only">Change member role</legend>
      <input type="hidden" name="sub" .value=${member.id}>
      ${roleField(memberRoleId(member.id), 'Role for ' + member.email, member.role, workspace.can_grant_owner)}
      <div class="fd-row">
        <button class="fd-btn" type="submit" data-variant="outline">Save role</button>
        <button class="fd-btn" type="button" data-variant="ghost" @click=${() => controls.cancel(memberMenuId(member.id))}>Cancel</button>
      </div>
    </fieldset>
  </form>`;
}

function invitations(workspace: Workspace, controls: Controls) {
  return html`<div class="fd-stack" data-gap="3">
    <h3 class="fd-title">Open invitations</h3>
    ${table('Open invitations', ['Email', 'Role', 'Expires', ...(workspace.editable ? ['Actions'] : [])],
      workspace.invitations.map(invite => {
        const id = inviteMenuId(invite.id);
        const busy = controls.busy(id);
        return {
          id, busy, cells: [invite.email, cap(invite.role), when(invite.expires_at), ...(workspace.editable
            ? [rowMenu(id, 'More actions for invitation to ' + invite.email, [{
              label: 'Revoke', danger: true, run: () => controls.hold(id, 'Revoking invitation to ' + invite.email,
                'revoke-invitation', { invitation_id: invite.id }),
            }], controls.pending || busy)] : [])],
        };
      }))}
  </div>`;
}

function inviteForm(workspace: Workspace, { pending, submit, invitationError }: Controls) {
  return html`<form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('invite', event)}>
    <fieldset class="fd-row" data-align="end" data-wrap data-gap="3" ?disabled=${pending}>
      <legend class="fd-sr-only">Invite team members</legend>
      ${field('workspace-invite-email', 'Email', { name: 'email', type: 'email', required: true, max: 254 })}
      ${roleField('workspace-invite-role', 'Invitation role', 'member', workspace.can_grant_owner)}
      <button class="fd-btn" type="submit" data-variant="primary">Send invitation</button>
    </fieldset>
    ${invitationError ? inlineError(invitationError) : nothing}
  </form>`;
}
