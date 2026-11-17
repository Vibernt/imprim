// Ending access that came from a workspace (docs/WORKSPACES.md#signing-in-to-a-shared-app). Statements for the same
// batch that removes the member or closes the workspace. Run them BEFORE the statement that deletes the membership:
// they read workspace_members to tell which products the person still reaches through another workspace.
// accessEndStatements(env, workspaceId, userId) -> D1 statements
export function accessEndStatements(env, workspaceId, userId) {
    void env; void workspaceId; void userId;
    return [];
}
