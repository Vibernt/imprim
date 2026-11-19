// App-authenticated workspace operations. Imprim checks participation, roles and the actor's session.
export function workspaceMethods(send, fail) {
    function segment(value) {
        if (typeof value !== 'string' || !value || value === '.' || value === '..')
            fail('configuration', 'Invalid workspace API identifier.');
        try { return encodeURIComponent(value); }
        catch { fail('configuration', 'Invalid workspace API identifier.'); }
    }
    const workspacePath = id => `/v1/workspaces/${segment(id)}`;
    function sendAsActor(method, path, actorToken, body = {}) {
        if (typeof actorToken !== 'string' || !actorToken) fail('configuration', 'An actor token is required.');
        return send(method, path, { ...body, actor_token: actorToken });
    }
    return {
        async memberships(sub) {
            if (typeof sub !== 'string' || !sub) fail('configuration', 'A subject is required.');
            return send('GET', `/v1/memberships?${new URLSearchParams({ sub })}`);
        },
        async joinableWorkspaces({ actorToken } = {}) {
            return sendAsActor('POST', '/v1/workspaces/joinable', actorToken);
        },
        async workspace(id) {
            return send('GET', workspacePath(id));
        },
        async workspaceMembers(id, { limit, cursor } = {}) {
            if ((limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) ||
                (cursor !== undefined && cursor !== null && typeof cursor !== 'string'))
                fail('configuration', 'Invalid workspace member list options.');
            const query = new URLSearchParams();
            if (limit !== undefined) query.set('limit', String(limit));
            if (cursor) query.set('cursor', cursor);
            return send('GET', `${workspacePath(id)}/members` + (query.size ? `?${query}` : ''));
        },
        async createWorkspace({ kind, name, products, firstOwnerEmail, actorToken } = {}) {
            if (kind !== undefined && kind !== 'team' && kind !== 'personal') fail('configuration', 'Invalid workspace kind.');
            const body = kind === 'personal' ? { kind, name } : { name, products, first_owner_email: firstOwnerEmail };
            return sendAsActor('POST', '/v1/workspaces', actorToken, body);
        },
        async renameWorkspace(id, { name, actorToken } = {}) {
            return sendAsActor('PATCH', workspacePath(id), actorToken, { name });
        },
        async setWorkspaceProducts(id, { add, remove, actorToken } = {}) {
            return sendAsActor('POST', `${workspacePath(id)}/products`, actorToken, { add: add ?? [], remove: remove ?? [] });
        },
        async inviteToWorkspace(id, { email, role, actorToken } = {}) {
            return sendAsActor('POST', `${workspacePath(id)}/invitations`, actorToken, { email, role });
        },
        async workspaceInvitations(id) {
            return send('GET', `${workspacePath(id)}/invitations`);
        },
        async revokeWorkspaceInvitation(id, invitationId, { actorToken } = {}) {
            return sendAsActor('DELETE', `${workspacePath(id)}/invitations/${segment(invitationId)}`, actorToken);
        },
        async setMemberRole(id, sub, { role, actorToken } = {}) {
            return sendAsActor('POST', `${workspacePath(id)}/members/${segment(sub)}`, actorToken, { role });
        },
        async removeMember(id, sub, { actorToken } = {}) {
            return sendAsActor('DELETE', `${workspacePath(id)}/members/${segment(sub)}`, actorToken);
        },
        async closeWorkspace(id, { actorToken, confirm } = {}) {
            if (confirm !== undefined && typeof confirm !== 'string') fail('configuration', 'Invalid workspace confirmation.');
            return sendAsActor('POST', `${workspacePath(id)}/close`, actorToken, confirm === undefined ? {} : { confirm });
        },
        async holdWorkspace(id, reason) {
            return send('PUT', `${workspacePath(id)}/holds`, { reason });
        },
        async releaseWorkspace(id, reason) {
            return send('DELETE', `${workspacePath(id)}/holds`, { reason });
        },
        async registerWorkspaceResource(id, resource) {
            return send('PUT', `${workspacePath(id)}/resources`, { resource });
        },
        async unregisterWorkspaceResource(id, resource) {
            return send('DELETE', `${workspacePath(id)}/resources`, { resource });
        }
    };
}
