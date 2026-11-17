import { invariant } from '../../lib/errors.mjs';
import { json, redirect } from '../../lib/http.mjs';
import { adminWorkspaceWrites, workspacesEnabled } from '../../workspaces/model.mjs';
import { sendWorkspaceInvitation } from '../../workspaces/email.mjs';
import { closePage, detailPage } from './detail.mjs';
import { createPage, disabledPage, emailFailurePage, listPage } from './pages.mjs';
import { listWorkspaces, workspaceDetail, workspacePath } from './read.mjs';

const validWorkspaceId = id => /^[A-Za-z0-9_-]{1,64}$/.test(id ?? '');
const lines = value => (value ?? '').split('\n').map(line => line.trim()).filter(Boolean);

export async function workspaceGet(env, session, csrf, id, action, query) {
    invariant((!id && !action) || (validWorkspaceId(id) && (!action || action === 'close')),
        'not_found', 'Admin endpoint not found.', 404);
    if (!await workspacesEnabled(env)) return disabledPage();
    if (!id) return query.get('create') === '1' ? createPage(csrf) : listPage(await listWorkspaces(env, query), query.get('status') ?? '');
    const workspace = await workspaceDetail(env, id);
    if (!action) return detailPage(workspace, csrf, session);
    invariant(workspace.status === 'active', 'workspace_closed', 'Workspace is closed.', 409);
    invariant(!workspace.holds.length, 'workspace_held', 'Workspace is held.', 409);
    return closePage(workspace, csrf);
}

// Entry is after the console's session, reauthentication, Origin and CSRF gates.
export async function workspacePost(request, env, ctx, session, id, action, body) {
    invariant(await workspacesEnabled(env), 'not_found', 'Shared workspaces are off.', 404);
    invariant(id === undefined || validWorkspaceId(id), 'not_found', 'Workspace not found.', 404);
    const writes = adminWorkspaceWrites(env, session);
    if (!id) {
        const { workspace, invitation } = await writes.create({ name: body.name, products: lines(body.products), first_owner_email: body.first_owner_email });
        return finish(request, env, ctx, workspace.workspace_id, invitation);
    }
    switch (action) {
        case 'rename': await writes.rename(id, body.name); break;
        case 'products': await writes.products(id, { add: lines(body.add), remove: lines(body.remove) }); break;
        case 'invite': {
            const { invitation } = await writes.invite(id, body);
            return finish(request, env, ctx, id, invitation);
        }
        case 'revoke-invitation': await writes.revokeInvitation(id, target(body.invitation_id)); break;
        case 'role': await writes.changeRole(id, target(body.sub), body.role); break;
        case 'remove-member': await writes.removeMember(id, target(body.sub)); break;
        case 'close': await writes.close(id); break;
        default: invariant(false, 'not_found', 'Admin endpoint not found.', 404);
    }
    return redirect(workspacePath(id));
}

function target(value) {
    invariant(typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value),
        'invalid_request', 'Invalid workspace action target.');
    return value;
}

async function finish(request, env, ctx, id, invitation) {
    if (invitation) {
        try { await sendWorkspaceInvitation(env, ctx, invitation); }
        catch {
            if (request.headers.get('accept')?.includes('text/html')) return emailFailurePage(id);
            return json({ error: 'workspace_invitation_email_failed', error_description: 'The invitation is saved, but email delivery failed.',
                workspace_id: id }, 503);
        }
    }
    return redirect(workspacePath(id));
}
