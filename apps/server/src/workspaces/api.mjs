import { json, readBody, uniqueParams } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { b64url, from64 } from '../lib/crypto.mjs';
import { limitAddress } from '../auth/rate-limit.mjs';
import { authenticatedClient } from '../oidc/token.mjs';
import { GRANTS_PAGE_MAX } from '../machines/endpoints.mjs';
import { verifyActor } from './actor.mjs';
import { sendWorkspaceInvitation } from './email.mjs';
import {
    workspacesEnabled, memberships, getWorkspace, workspaceMembers, workspaceInvitations, createWorkspace,
    renameWorkspace, setWorkspaceProducts, inviteToWorkspace, revokeWorkspaceInvitation, setWorkspaceMemberRole,
    removeWorkspaceMember, closeWorkspace, putWorkspaceHold, deleteWorkspaceHold, changeWorkspaceResource
} from './model.mjs';

const membershipsPath = (method, path) => method === 'GET' && path === '/v1/memberships';
export const workspaceApiPath = (method, path) => membershipsPath(method, path) || /^\/v1\/workspaces(?:\/|$)/.test(path);
const workspacePath = /^\/v1\/workspaces\/([A-Za-z0-9_-]{1,64})(?:\/(members|products|invitations|close|holds|resources)(?:\/([^/]+))?)?$/;
const validSub = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);

function pathId(value) {
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { invariant(false, 'invalid_request', 'Invalid path parameter.'); }
    invariant(validSub(decoded), 'invalid_request', 'Invalid path parameter.');
    return decoded;
}

function memberCursor(value) {
    let cursor;
    invariant(value.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(value), 'invalid_request', 'Invalid cursor.');
    try { cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(from64(value))); } catch { cursor = null; }
    invariant(Array.isArray(cursor) && cursor.length === 2 && Number.isSafeInteger(cursor[0]) && validSub(cursor[1]),
        'invalid_request', 'Invalid cursor.');
    return cursor;
}

async function membersResponse(env, client, id, url) {
    const { limit, cursor } = uniqueParams(url.searchParams);
    invariant(limit === undefined || /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= GRANTS_PAGE_MAX,
        'invalid_request', 'limit is 1 to {max}.', 400, { max: GRANTS_PAGE_MAX });
    const size = Number(limit ?? GRANTS_PAGE_MAX);
    const { version, rows } = await workspaceMembers(env, client, id, size, cursor === undefined ? null : memberCursor(cursor));
    const page = rows.slice(0, size), last = page.at(-1);
    return json({ members: page.map(({ sub, email, role }) => ({ sub, email, role })),
        next_cursor: rows.length > size ? b64url(new TextEncoder().encode(JSON.stringify([last.created, last.sub]))) : null, version });
}

async function sendInvitation(env, ctx, invitation) {
    const delivery = sendWorkspaceInvitation(env, ctx, invitation);
    if (ctx) ctx.waitUntil(delivery);
    else await delivery;
}

async function requestBody(request, env) {
    if (request.method === 'GET' || (!request.body && !request.headers.has('content-type'))) return {};
    try { return await readBody(request); }
    catch (error) {
        await limitAddress(env, request);
        throw error;
    }
}

export async function workspaceApi(request, env, ctx, url) {
    const { method } = request, path = url.pathname;
    const body = await requestBody(request, env);
    if (request.headers.has('authorization') && Object.hasOwn(body, 'client_secret')) {
        await limitAddress(env, request);
        invariant(false, 'invalid_client', 'Conflicting client credentials.', 401);
    }
    const client = await authenticatedClient(request, env, body, true, { post: true });
    invariant(await workspacesEnabled(env) && client.workspaces === 'shared' && client.product,
        'not_found', 'Workspace API is not available.', 404);

    if (membershipsPath(method, path)) {
        const { sub } = uniqueParams(url.searchParams);
        invariant(validSub(sub), 'invalid_request', 'Invalid sub.');
        return json({ memberships: await memberships(env, client, sub) });
    }
    if (method === 'POST' && path === '/v1/workspaces') {
        const actor = await verifyActor(env, client, body.actor_token);
        const { workspace, invitation } = await createWorkspace(env, client, actor, body);
        if (invitation) await sendInvitation(env, ctx, invitation);
        return json(workspace, 201);
    }

    const match = workspacePath.exec(path);
    invariant(match, 'not_found', 'Endpoint not found.', 404);
    const [, id, section = '', target] = match;
    const route = method + ' ' + section + (target ? '/id' : '');
    switch (route) {
        case 'GET ': return json(await getWorkspace(env, client, id));
        case 'GET members': return membersResponse(env, client, id, url);
        case 'GET invitations': return json({ invitations: await workspaceInvitations(env, client, id) });
        case 'PUT holds': return json(await putWorkspaceHold(env, client, id, body.reason));
        case 'DELETE holds': return json(await deleteWorkspaceHold(env, client, id));
        case 'PUT resources': case 'DELETE resources':
            return json(await changeWorkspaceResource(env, client, id, body.resource, method === 'PUT'));
    }
    return actorWrite(env, ctx, client, id, route, target, body);
}

async function actorWrite(env, ctx, client, id, route, target, body) {
    invariant(['PATCH ', 'POST products', 'POST invitations', 'DELETE invitations/id', 'POST members/id',
        'DELETE members/id', 'POST close'].includes(route), 'not_found', 'Endpoint not found.', 404);
    const actor = await verifyActor(env, client, body.actor_token);
    switch (route) {
        case 'PATCH ': return json(await renameWorkspace(env, client, actor, id, body.name));
        case 'POST products': return json(await setWorkspaceProducts(env, client, actor, id, body));
        case 'POST invitations': {
            const { invitation, expires } = await inviteToWorkspace(env, client, actor, id, body);
            await sendInvitation(env, ctx, invitation);
            return json({ invitation_id: invitation.invitationId, expires_at: expires }, 201);
        }
        case 'DELETE invitations/id': return json(await revokeWorkspaceInvitation(env, client, actor, id, pathId(target)));
        case 'POST members/id': return json(await setWorkspaceMemberRole(env, client, actor, id, pathId(target), body.role));
        case 'DELETE members/id': return json(await removeWorkspaceMember(env, client, actor, id, pathId(target)));
        case 'POST close': return json(await closeWorkspace(env, client, actor, id));
    }
}
