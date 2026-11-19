import { readJson, requireCsrf } from '../../api/json.mjs';
import { invariant } from '../../lib/errors.mjs';
import { json, redirect } from '../../lib/http.mjs';
import { adminWorkspaceWrites, workspacesEnabled } from '../../workspaces/model.mjs';
import { sendWorkspaceInvitation } from '../../workspaces/email.mjs';
import { requireAdminFresh } from '../auth.mjs';
import { workspaceEmailFailure } from './result.mjs';
import { listWorkspaces, pageSize, workspaceDetail, workspacePath } from './read.mjs';

const validId = id => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const lines = value => (value ?? '').split('\n').map(line => line.trim()).filter(Boolean);
const target = value => {
    invariant(typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value),
        'invalid_request', 'Invalid workspace action target.');
    return value;
};

export async function workspaceApi(request, env, ctx, session, id, action, query) {
    if (request.method === 'GET') {
        invariant(id === undefined || (validId(id) && (!action || action === 'close')), 'not_found', 'Admin endpoint not found.', 404);
        if (!await workspacesEnabled(env)) return json({ enabled: false });
        if (id) {
            const workspace = await workspaceDetail(env, id);
            if (action === 'close') {
                invariant(workspace.status === 'active', 'workspace_closed', 'Workspace is closed.', 409);
                invariant(!workspace.holds.length, 'workspace_held', 'Workspace is held.', 409);
            }
            return json({ enabled: true, workspace: withControls(workspace, session.user_id) });
        }
        const rows = await listWorkspaces(env, query);
        return json({ enabled: true, workspaces: rows.slice(0, pageSize), next: rows.length > pageSize ? rows[pageSize - 1].id : null });
    }
    await requireCsrf(request, env, session);
    const body = await readJson(request);
    requireAdminFresh(session);
    if (action === 'close') invariant(typeof body.confirm === 'string' && body.confirm.length <= 120,
        'invalid_request', 'Type the workspace name to confirm closure.');
    const result = await writeWorkspace(env, ctx, session, id, action, body, body.confirm);
    return workspaceResponse(result);
}

// Present the same controls the old console offered. The model still authorizes every action.
function withControls(workspace, sub) {
    const editable = workspace.status === 'active', team = workspace.kind === 'team';
    const owners = workspace.members.filter(member => member.role === 'owner');
    const isOwner = owners.some(owner => owner.id === sub);
    return { ...workspace, editable, can_invite: editable && team, can_grant_owner: isOwner,
        members: workspace.members.map(member => ({ ...member, manageable: editable && team &&
            (member.role !== 'owner' || (isOwner && owners.length > 1)) })) };
}

// Existing form clients keep their line-delimited fields and redirect.
export async function workspaceFormPost(request, env, ctx, session, id, action, body) {
    const input = { ...body, products: lines(body.products), add: lines(body.add), remove: lines(body.remove) };
    const result = await writeWorkspace(env, ctx, session, id, action, input);
    if (result.error) return request.headers.get('accept')?.includes('text/html')
        ? workspaceEmailFailure(workspacePath(result.workspace_id)) : workspaceResponse(result);
    return redirect(workspacePath(result.workspace_id));
}

function workspaceResponse(result) {
    return json(result, result.error ? 503 : 200);
}

// Both callers have checked the session, freshness, Origin and CSRF. The model guards the write again in its batch.
async function writeWorkspace(env, ctx, session, id, action, body, confirm) {
    invariant(await workspacesEnabled(env), 'not_found', 'Shared workspaces are off.', 404);
    invariant(id === undefined || validId(id), 'not_found', 'Workspace not found.', 404);
    const writes = adminWorkspaceWrites(env, session);
    if (id === undefined) {
        const { workspace, invitation } = await writes.create({ name: body.name, products: body.products, first_owner_email: body.first_owner_email });
        return finish(env, ctx, workspace.workspace_id, invitation);
    }
    switch (action) {
        case 'rename': await writes.rename(id, body.name); break;
        case 'products': await writes.products(id, { add: body.add, remove: body.remove }); break;
        case 'invite': {
            const { invitation } = await writes.invite(id, body);
            return finish(env, ctx, id, invitation);
        }
        case 'revoke-invitation': await writes.revokeInvitation(id, target(body.invitation_id)); break;
        case 'role': await writes.changeRole(id, target(body.sub), body.role); break;
        case 'remove-member': await writes.removeMember(id, target(body.sub)); break;
        case 'close': await writes.close(id, confirm); break;
        default: invariant(false, 'not_found', 'Admin endpoint not found.', 404);
    }
    return { workspace_id: id };
}

async function finish(env, ctx, id, invitation) {
    if (invitation) {
        try { await sendWorkspaceInvitation(env, ctx, invitation); }
        catch {
            return { error: 'workspace_invitation_email_failed', error_description: 'The invitation is saved, but email delivery failed.',
                workspace_id: id };
        }
    }
    return { workspace_id: id };
}
