import { json, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { accountWorkspace, accountWorkspaces, accountWorkspacesPath, canSeeAccountWorkspaces,
    requireVisibleWorkspace } from '../workspaces/account-read.mjs';
import { sendWorkspaceInvitation } from '../workspaces/email.mjs';
import { memberCursor, workspaceTarget } from '../workspaces/member-page.mjs';
import { inviteToWorkspace, removeWorkspaceMember, renameWorkspace, revokeWorkspaceInvitation, setWorkspaceMemberRole } from '../workspaces/model.mjs';
import { readJson, requireApiSession, requireCsrf } from './json.mjs';

const root = '/v1' + accountWorkspacesPath;
export const accountWorkspaceApiPath = path => path === root || path.startsWith(root + '/');
const route = /^([A-Za-z0-9_-]{1,64})(?:\/(invitations|members)\/([^/]+)\/(revoke|role|remove)|\/(invitations|leave|rename))?$/;
const postActions = new Set(['invitations', 'invitations/revoke', 'members/role', 'members/remove', 'leave', 'rename']);
// The URL parser removes literal and percent-encoded dot segments. An encoded colon still names a literal subject.
const memberTarget = segment => segment === ':dot' ? '.' : segment === ':dotdot' ? '..' : workspaceTarget(segment);

export async function accountWorkspaceApi(request, env, ctx, url) {
    const session = await requireApiSession(request, env), sub = session.user_id;
    if (request.method === 'GET' && url.pathname === root) return json({ workspaces: await accountWorkspaces(env, sub) });
    const match = route.exec(url.pathname.slice(root.length + 1));
    requireVisibleWorkspace(match);
    const [, id, collection, target, action, direct] = match;
    const operation = direct ?? (collection && collection + '/' + action);
    if (request.method === 'POST') await requireCsrf(request, env, session);
    requireVisibleWorkspace(await canSeeAccountWorkspaces(env, sub, id));
    if (request.method === 'GET' && !operation) {
        const { after } = uniqueParams(url.searchParams);
        return json(await accountWorkspace(env, sub, id, memberCursor(after)));
    }
    invariant(request.method === 'POST' && postActions.has(operation), 'not_found', 'Endpoint not found.', 404);
    const actor = { user: { id: sub, email: session.email, email_verified: session.email_verified }, session, source: 'account' };
    const needsBody = operation === 'invitations' || operation === 'members/role' || operation === 'rename';
    const body = needsBody || request.body || request.headers.has('content-type') ? await readJson(request) : {};
    return accountWorkspaceWrite(env, ctx, actor, id, operation, target, body);
}

async function accountWorkspaceWrite(env, ctx, actor, id, operation, target, body) {
    switch (operation) {
        case 'invitations': {
            const { invitation, expires } = await inviteToWorkspace(env, null, actor, id, body);
            try { await sendWorkspaceInvitation(env, ctx, invitation); }
            catch {
                invariant(false, 'workspace_invitation_email_failed', 'The invitation is saved, but email delivery failed.', 503);
            }
            return json({ invitation_id: invitation.invitationId, expires_at: expires }, 201);
        }
        case 'invitations/revoke': await revokeWorkspaceInvitation(env, null, actor, id, workspaceTarget(target)); break;
        case 'members/role': await setWorkspaceMemberRole(env, null, actor, id, memberTarget(target), body.role); break;
        case 'members/remove': await removeWorkspaceMember(env, null, actor, id, memberTarget(target), { allowSelfLeave: false }); break;
        case 'leave':
            await removeWorkspaceMember(env, null, actor, id, actor.user.id);
            return json({ workspaces_available: await canSeeAccountWorkspaces(env, actor.user.id) });
        case 'rename': await renameWorkspace(env, null, actor, id, body.name); break;
    }
    return json({});
}
