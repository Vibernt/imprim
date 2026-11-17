// The workspace invitation email (docs/WORKSPACES.md#email). Called after the invitation batch commits.
// sendWorkspaceInvitation(env, ctx, { invitationId, workspaceId, email, role, inviterEmail, viaClient }) -> Promise<void>
export async function sendWorkspaceInvitation(env, ctx, invitation) {
    void env; void ctx; void invitation;
}
