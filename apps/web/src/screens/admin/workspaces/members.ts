import { html, nothing } from 'lit';
import { card } from '../../page-layout';
import { cap, field, when } from '../realm-ui';
import { roleField } from './forms';
import { optionalTable } from './summary';
import type { Submit, Workspace } from './types';

export function members(workspace: Workspace, pending: boolean, submit: Submit) {
  const editable = workspace.editable && workspace.kind === 'team';
  return card('Members', optionalTable('Members', ['Email', 'Role', ...(editable ? ['Actions'] : [])], workspace.members.map((member, index) =>
      [member.email, cap(member.role), ...(editable ? [!member.manageable ? '—' : html`
        <div class="fd-row" data-wrap data-align="end" data-gap="3">
          <form method="post" @submit=${(event: SubmitEvent) => submit('role', event)}>
            <fieldset class="fd-row" data-align="end" data-gap="2" ?disabled=${pending}>
              <legend class="fd-sr-only">Member role</legend>
              <input type="hidden" name="sub" .value=${member.id}>
              ${roleField('member-role-' + index, 'Role for ' + member.email, member.role, workspace.can_grant_owner)}
              <button class="fd-btn" type="submit" data-variant="outline" data-size="sm">Save role</button>
            </fieldset>
          </form>
          <form method="post" @submit=${(event: SubmitEvent) => submit('remove-member', event)}>
            <input type="hidden" name="sub" .value=${member.id}>
            <button class="fd-btn" type="submit" data-variant="danger" data-size="sm" aria-label=${'Remove ' + member.email} ?disabled=${pending}>Remove member</button>
          </form>
        </div>`] : [])]), 'Members appear after accepting an invitation.'));
}

export function invitations(workspace: Workspace, pending: boolean, submit: Submit) {
  return card('Open invitations', html`
    ${optionalTable('Open invitations', ['Email', 'Role', 'Expires', ...(workspace.editable ? ['Actions'] : [])],
      workspace.invitations.map(invite => [invite.email, cap(invite.role), when(invite.expires_at), ...(workspace.editable ? [html`
        <form method="post" @submit=${(event: SubmitEvent) => submit('revoke-invitation', event)}>
          <input type="hidden" name="invitation_id" .value=${invite.id}>
          <button class="fd-btn" type="submit" data-variant="outline" data-size="sm" aria-label=${'Revoke invitation for ' + invite.email} ?disabled=${pending}>Revoke</button>
        </form>`] : [])]), 'Invitations appear here until they are accepted, revoked or expire.')}
    ${workspace.can_invite ? html`<form class="fd-form" method="post" ?inert=${pending} @submit=${(event: SubmitEvent) => submit('invite', event)}>
      ${field('workspace-invite-email', 'Email', { name: 'email', type: 'email', required: true, max: 254 })}
      ${roleField('workspace-invite-role', 'Invitation role', 'member', workspace.can_grant_owner)}
      <div class="fd-form-actions"><button class="fd-btn" type="submit" data-variant="outline" ?disabled=${pending}>Send invitation</button></div>
    </form>` : nothing}
  `);
}
