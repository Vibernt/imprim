import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { resourceUrl, underPrefix } from '../agents/uris.mjs';
import { agentSettings } from '../agents/settings.mjs';
import { adminWriteGuard } from '../admin/auth.mjs';
import { liveActorSession } from './actor.mjs';
import { workspaceEventStatements } from './events.mjs';
import { accessEndStatements } from './teardown.mjs';

const PRODUCT = /^[a-z][a-z0-9-]{1,39}$/;
const ownProductRequired = 'An app may only use its own product.';
export const workspaceRoles = ['owner', 'admin', 'member', 'viewer'];
const invitationLifetime = 30 * 86400000;
export const workspaceId = () => 'ws_' + crypto.randomUUID().replaceAll('-', '');
const realmOn = "SELECT 1 FROM realms WHERE id=? AND status='active' AND json_extract(config,'$.workspaces')='on'";

export async function workspacesEnabled(env) {
    // The request's realm binding exposes the id, but does not project arbitrary config into env.
    return Boolean(await env.DB.prepare(realmOn).bind(realmId(env)).first());
}

const productList = `(SELECT json_group_array(product) FROM
    (SELECT product FROM workspace_products WHERE workspace_id=w.id ORDER BY product))`;
const usingProduct = 'EXISTS(SELECT 1 FROM workspace_products WHERE workspace_id=w.id AND product=?)';
const workspaceRead = (env, client, id) => env.DB.prepare(`SELECT w.id AS workspace_id,w.name,w.kind,w.status,w.version,${productList} AS products
    FROM workspaces w WHERE w.id=? AND w.realm_id=? AND ${usingProduct}`).bind(id, realmId(env), client.product);
const withProducts = row => ({ ...row, products: JSON.parse(row.products) });
const foundWorkspace = row => {
    invariant(row, 'not_found', 'Workspace not found.', 404);
    return withProducts(row);
};

export async function memberships(env, client, sub) {
    const { results } = await env.DB.prepare(`SELECT w.id AS workspace_id,w.name,w.kind,m.role,w.version,${productList} AS products
        FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
        WHERE w.realm_id=? AND w.status='active' AND m.user_id=? AND ${usingProduct} ORDER BY w.created,w.id`)
        .bind(realmId(env), sub, client.product).all();
    return results.map(withProducts);
}

export async function getWorkspace(env, client, id) {
    return foundWorkspace(await workspaceRead(env, client, id).first());
}

export async function workspaceMembers(env, client, id, limit, after) {
    const [workspace, page] = await env.DB.batch([
        workspaceRead(env, client, id),
        env.DB.prepare(`SELECT m.user_id AS sub,u.email,m.role,m.created FROM workspace_members m JOIN users u ON u.id=m.user_id
            WHERE m.workspace_id=? AND (? IS NULL OR (m.created,m.user_id)>(?,?))
            ORDER BY m.created,m.user_id LIMIT ?`).bind(id, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1)
    ]);
    return { version: foundWorkspace(workspace.results[0]).version, rows: page.results };
}

export async function workspaceInvitations(env, client, id) {
    const [workspace, invitations] = await env.DB.batch([
        workspaceRead(env, client, id),
        env.DB.prepare(`SELECT id AS invitation_id,email,role,expires_at FROM workspace_invitations
            WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?
            ORDER BY created,id`).bind(id, Date.now())
    ]);
    foundWorkspace(workspace.results[0]);
    return invitations.results;
}

function boundedText(value, max, field) {
    invariant(typeof value === 'string' && value.trim() && !value.includes('\0') && [...value.trim()].length <= max,
        'invalid_request', '{field} must be between 1 and {max} characters.', 400, { field, max });
    return value.trim();
}

function validProducts(products, client) {
    invariant(Array.isArray(products), 'invalid_request', 'Invalid products.');
    invariant(products.every(p => client ? p === client.product : typeof p === 'string' && PRODUCT.test(p)),
        'invalid_request', client ? ownProductRequired : 'Invalid products.');
    return [...new Set(products)];
}

function validRole(role) {
    invariant(workspaceRoles.includes(role), 'invalid_request', 'Invalid workspace role.');
    return role;
}

const check = (sql, args, code, message, status) => ({ sql, args, code, message, status });
const denied = (sql, args, message = 'Workspace permissions are required.') => check(sql, args, 'access_denied', message, 403);
const missing = (sql, args, message = 'Workspace not found.') => check(sql, args, 'not_found', message, 404);
const conflict = (sql, args, code, message) => check(sql, args, code, message, 409);

function writeChecks(env, client, actor, id, now, creating, joinGuard) {
    const realm = realmId(env);
    const checks = [missing(`EXISTS(${realmOn})`, [realm])];
    if (client) {
        checks.push(missing(`EXISTS(SELECT 1 FROM clients WHERE id=? AND realm_id=? AND secret_hash IS ?
            AND workspaces='shared' AND product=?)`, [client.id, realm, client.secret_hash, client.product]));
    } else {
        const { sql, args } = adminWriteGuard(env, actor.admin, true, Date.now());
        checks.push(conflict(sql, args, 'conflict', 'Authorization or account changed; reload and reauthenticate.'));
    }
    if (!creating) {
        const productVisibility = joinGuard ? `(${usingProduct} OR (w.status='active' AND ${joinGuard.sql}))` : usingProduct;
        const productGuard = client ? ` AND ${productVisibility}` : '';
        checks.push(
            missing(`EXISTS(SELECT 1 FROM workspaces w WHERE w.id=? AND w.realm_id=?${productGuard})`,
                [id, realm, ...(client ? [client.product] : []), ...(joinGuard?.args ?? [])]),
            conflict("EXISTS(SELECT 1 FROM workspaces WHERE id=? AND status='active')", [id], 'workspace_closed', 'Workspace is closed.'));
    }
    if (client && actor) checks.push(check(`EXISTS(SELECT 1 ${liveActorSession})`, [actor.session.sid, actor.user.id, now, realm],
        'invalid_request', 'Actor token does not name a live session.', 400));
    return checks;
}

// The conditional write claims the next version. The assertion aborts the batch if no version was claimed,
// unless all guards passed and the requested state already exists.
export async function guardedWrite(env, { client, actor, auditActor, id, now = Date.now(), checks, create, joinGuard,
    effects = [], afterEvent = [], event, eventOptions, audit, detail = {}, unjoined, writeIf, finalEffect }) {
    const guards = [...writeChecks(env, client, actor, id, now, Boolean(create), joinGuard), ...checks];
    const where = guards.map(guard => `(${guard.sql})`).join(' AND '), args = guards.flatMap(guard => guard.args);
    const condition = writeIf ? ` AND (${writeIf.sql})` : '', conditionArgs = writeIf?.args ?? [];
    const write = create
        ? env.DB.prepare(`INSERT INTO workspaces(id,realm_id,kind,name,personal_owner,created,created_via) SELECT ?,?,?,?,?,?,? WHERE ${where}`)
            .bind(id, realmId(env), create.kind, create.name, create.owner, now, create.via ?? null, ...args)
        : env.DB.prepare(`UPDATE workspaces SET version=version+1 WHERE id=? AND ${where}${condition}`).bind(id, ...args, ...conditionArgs);
    const assertion = writeIf
        ? env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT 0 WHERE changes()<>1 AND NOT (${where} AND NOT (${writeIf.sql}))`)
            .bind(...args, ...conditionArgs)
        : env.DB.prepare('INSERT INTO admin_assertions(ok) SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END');
    const auditDetail = unjoined ? `json_patch(?, CASE WHEN (${unjoined.sql}) THEN '{"unjoined":true}' ELSE '{}' END)` : '?';
    const record = env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
        SELECT ?,?,?,json_set(${auditDetail},'$.version',version),?,realm_id FROM workspaces WHERE id=?${condition}`)
        .bind(audit ?? event, auditActor ?? actor?.user.id ?? client.id, id, JSON.stringify({ ...detail, ...(client ? { client_id: client.id } : { source: 'admin_console' }) }),
            ...(unjoined?.args ?? []), now, id, ...conditionArgs);
    let result;
    try {
        result = await env.DB.batch([write, assertion, ...effects, ...workspaceEventStatements(env, id, event, { ...eventOptions, writeIf }),
            ...afterEvent, record, ...(finalEffect ? [finalEffect] : []),
            env.DB.prepare(`SELECT w.id AS workspace_id,w.name,w.kind,w.status,w.version,${productList} AS products FROM workspaces w WHERE w.id=?`).bind(id)]);
    } catch (error) {
        if (![error.message, error.cause?.message].some(message => message?.includes('CHECK constraint failed: admin_assertions'))) throw error;
        const failed = await env.DB.prepare(`SELECT CASE ${guards.map((guard, i) => `WHEN NOT (${guard.sql}) THEN ${i}`).join(' ')} END AS failure`)
            .bind(...args).first();
        const guard = failed?.failure == null ? null : guards[failed.failure];
        if (guard) {
            const message = typeof guard.message === 'function' ? await guard.message() : guard.message;
            invariant(false, guard.code, message, guard.status);
        }
        invariant(false, 'conflict', 'Workspace or permissions changed. Reload and try again.', 409);
    }
    invariant(writeIf || result[0].meta.changes === 1, 'conflict', 'Workspace write was not applied.', 409);
    return withProducts(result.at(-1).results[0]);
}

const membership = (rolesSql = '') => `EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=? ${rolesSql})`;
const adminMember = membership("AND role IN ('owner','admin')");
const ownerMember = membership("AND role='owner'");
const actorRole = (id, actor, sql = adminMember, unjoined) => unjoined
    ? denied(`(${sql} OR (${unjoined.sql}))`, [id, actor.user.id, ...unjoined.args])
    : denied(sql, [id, actor.user.id]);
const manage = (id, actor, unjoined) => actor.admin ? [] : [actorRole(id, actor, adminMember, unjoined)];
const flag = (client, name) => denied(`EXISTS(SELECT 1 FROM clients WHERE id=? AND ${name}='on')`, [client.id], 'App is not enabled for this workspace operation.');

// Product visibility and the live actor are checked by writeChecks. These writes leave the roster intact,
// so the audit can use the same predicate as the permission guard.
const unjoinedAppRule = (client, id) => client && {
    sql: `EXISTS(SELECT 1 FROM workspaces w WHERE w.id=? AND w.kind='team'
        AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w.id))
        AND EXISTS(SELECT 1 FROM clients WHERE id=? AND workspace_admin='on')`,
    args: [id, client.id]
};

export function addProducts(env, id, products, now) {
    return env.DB.prepare(`INSERT INTO workspace_products(workspace_id,product,created)
        SELECT ?,j.value,? FROM json_each(?) j WHERE true ON CONFLICT(workspace_id,product) DO NOTHING`).bind(id, now, JSON.stringify(products));
}

export function addWorkspaceOwner(env, id, owner, now) {
    return env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES(?,?,'owner',?,?)")
        .bind(id, owner, now, now);
}

function creationProducts(client, personal, products) {
    if (!client) return validProducts(products);
    if (!personal && products !== undefined) {
        invariant(Array.isArray(products) && products.length === 1 && products[0] === client.product,
            'invalid_request', ownProductRequired);
    }
    return [client.product];
}

function newInvitation(env, client, actor, id, email, role, now) {
    const invitationId = crypto.randomUUID(), expires = now + invitationLifetime;
    const statement = env.DB.prepare(`INSERT INTO workspace_invitations(id,workspace_id,email,role,invited_by,via_client,created,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(invitationId, id, email, role, client ? actor.user.id : null, client?.id ?? null, now, expires);
    return { statement, expires, message: { invitationId, workspaceId: id, email, role, inviterEmail: actor.user.email, viaClient: client?.id ?? null } };
}

export async function createWorkspace(env, client, actor, body) {
    const kind = body.kind === undefined ? 'team' : body.kind, name = boundedText(body.name, 120, 'name');
    invariant(kind === 'team' || kind === 'personal', 'invalid_request', 'Invalid workspace kind.');
    const personal = kind === 'personal', now = Date.now(), id = workspaceId();
    const products = creationProducts(client, personal, body.products);
    const email = personal ? actor.user.email : normalizeEmail(body.first_owner_email);
    const owner = email === actor.user.email ? actor.user.id : null;
    const invitation = owner ? null : newInvitation(env, client, actor, id, email, 'owner', now);
    const checks = [...(client ? [flag(client, personal ? 'personal_workspaces' : 'workspace_admin')] : []),
        conflict('NOT EXISTS(SELECT 1 FROM workspaces WHERE id=?)', [id], 'conflict', 'Workspace id already exists.')];
    if (personal) checks.push(conflict('NOT EXISTS(SELECT 1 FROM workspaces WHERE personal_owner=?)', [actor.user.id],
        'personal_workspace_exists', 'This person already has a personal workspace.'));
    if (!personal) checks.push(conflict('EXISTS(SELECT 1 FROM users WHERE id=? AND email=?)',
        [actor.user.id, actor.user.email], 'conflict', 'Actor email changed. Reload and try again.'));
    const ownerStatement = owner && addWorkspaceOwner(env, id, owner, now);
    const workspace = await guardedWrite(env, { client, actor, id, now, checks, create: { kind, name, owner: personal ? owner : null },
        effects: [addProducts(env, id, products, now), ownerStatement || invitation.statement],
        event: owner ? 'workspace-member-added' : 'workspace-updated',
        eventOptions: owner ? { userId: owner, payload: { role: 'owner' } } : { payload: { name } },
        audit: 'workspace-created', detail: { kind, ...(invitation ? { invitation_id: invitation.message.invitationId } : {}) } });
    return { workspace, invitation: invitation?.message };
}

export function renameWorkspace(env, client, actor, id, value) {
    const name = boundedText(value, 120, 'name');
    return guardedWrite(env, { client, actor, id, checks: manage(id, actor),
        effects: [env.DB.prepare('UPDATE workspaces SET name=? WHERE id=?').bind(name, id)],
        event: 'workspace-updated', detail: { name } });
}

export function setWorkspaceProducts(env, client, actor, id, body) {
    const add = validProducts(body.add, client), remove = validProducts(body.remove, client);
    invariant(!add.some(product => remove.includes(product)), 'invalid_request', 'A product cannot be added and removed together.');
    const realmAdmin = `EXISTS(SELECT 1 FROM users u JOIN admins a ON a.realm_id=u.realm_id AND a.email=u.email
        WHERE u.id=? AND u.email_verified=1)`;
    const checks = actor.admin ? [] : [flag(client, 'workspace_admin'), denied(`(${ownerMember} OR ${realmAdmin})`, [id, actor.user.id, actor.user.id])];
    // Only adding the calling product can make an otherwise hidden workspace eligible for this write.
    const joinGuard = client && add.length ? {
        sql: checks.map(guard => guard.sql).join(' AND '),
        args: checks.flatMap(guard => guard.args)
    } : null;
    const now = Date.now();
    // Capture recipients after adding and before deleting. The event payload projects the final product list.
    return guardedWrite(env, { client, actor, id, now, checks, joinGuard,
        effects: [addProducts(env, id, add, now)],
        afterEvent: [env.DB.prepare('DELETE FROM workspace_products WHERE workspace_id=? AND product IN (SELECT value FROM json_each(?))')
            .bind(id, JSON.stringify(remove))],
        event: 'workspace-products-changed', eventOptions: { removeProducts: remove }, detail: { add, remove } });
}

export async function inviteToWorkspace(env, client, actor, id, body) {
    const email = normalizeEmail(body.email), role = validRole(body.role), now = Date.now();
    const invitation = newInvitation(env, client, actor, id, email, role, now);
    const unjoined = role === 'owner' ? unjoinedAppRule(client, id) : null;
    const checks = [...(role === 'owner' ? [actorRole(id, actor, ownerMember, unjoined)] : manage(id, actor)),
        conflict("EXISTS(SELECT 1 FROM workspaces WHERE id=? AND kind='team')", [id],
            'personal_workspace', 'A personal workspace does not take invitations.')];
    await guardedWrite(env, { client, actor, id, now, checks, unjoined,
        effects: [env.DB.prepare(`UPDATE workspace_invitations SET revoked_at=? WHERE workspace_id=? AND email=?
            AND accepted_at IS NULL AND revoked_at IS NULL`).bind(now, id, email), invitation.statement],
        event: 'workspace-updated', audit: 'workspace-invited', detail: { invitation_id: invitation.message.invitationId, role } });
    return { invitation: invitation.message, expires: invitation.expires };
}

export function revokeWorkspaceInvitation(env, client, actor, id, invitationId) {
    const open = 'id=? AND workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?', now = Date.now();
    const unjoined = unjoinedAppRule(client, id);
    return guardedWrite(env, { client, actor, id, now, unjoined, checks: [...manage(id, actor, unjoined),
        missing(`EXISTS(SELECT 1 FROM workspace_invitations WHERE ${open})`, [invitationId, id, now], 'Invitation not found.')],
        effects: [env.DB.prepare(`UPDATE workspace_invitations SET revoked_at=? WHERE ${open}`).bind(now, invitationId, id, now)],
        event: 'workspace-updated', audit: 'workspace-invitation-revoked', detail: { invitation_id: invitationId } });
}

function memberChangeChecks(id, actor, sub, role = null) {
    const removing = role === null;
    const selfLeave = removing && actor.user.id === sub;
    const ownerAuthority = denied(role === 'owner' ? ownerMember : `(NOT ${ownerMember} OR ${ownerMember})`,
        role === 'owner' ? [id, actor.user.id] : [id, sub, id, actor.user.id], 'Only an owner may grant or remove the owner role.');
    const lastOwner = role === 'owner' ? [] : [conflict(`(NOT ${ownerMember} OR
        EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id!=? AND role='owner'))`,
        [id, sub, id, sub], 'last_owner', 'Workspace must keep an owner.')];
    return [
        ...(actor.admin ? [] : [actorRole(id, actor, selfLeave ? membership() : adminMember)]),
        missing(membership(), [id, sub], 'Workspace member not found.'),
        ...(actor.admin ? [...lastOwner, ownerAuthority] : [ownerAuthority, ...lastOwner])
    ];
}

export function setWorkspaceMemberRole(env, client, actor, id, sub, value) {
    const role = validRole(value), now = Date.now();
    return guardedWrite(env, { client, actor, id, now, checks: memberChangeChecks(id, actor, sub, role),
        effects: [env.DB.prepare('UPDATE workspace_members SET role=?,updated=? WHERE workspace_id=? AND user_id=?').bind(role, now, id, sub)],
        event: 'workspace-role-changed', eventOptions: { userId: sub, payload: { role } }, detail: { sub, role } });
}

export function removeWorkspaceMember(env, client, actor, id, sub) {
    return guardedWrite(env, { client, actor, id, checks: memberChangeChecks(id, actor, sub),
        effects: [...accessEndStatements(env, id, sub),
            env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').bind(id, sub)],
        event: 'workspace-member-removed', eventOptions: { userId: sub }, detail: { sub } });
}

export async function closeWorkspace(env, client, actor, id, confirm) {
    const now = Date.now();
    const { results } = await env.DB.prepare(`SELECT m.user_id FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
        WHERE w.id=? AND w.realm_id=? ORDER BY m.user_id`).bind(id, realmId(env)).all();
    const members = results.map(row => row.user_id);
    const held = conflict('NOT EXISTS(SELECT 1 FROM workspace_holds WHERE workspace_id=?)', [id], 'workspace_held', async () => {
        const { results: holds } = await env.DB.prepare('SELECT reason FROM workspace_holds WHERE workspace_id=? ORDER BY client_id').bind(id).all();
        return 'Workspace is held. Reasons include ' + holds.map(hold => hold.reason).join(', ');
    });
    const unjoined = unjoinedAppRule(client, id);
    const checks = [...(actor.admin ? [] : [actorRole(id, actor, ownerMember, unjoined)]), held,
        ...(confirm === undefined ? [] : [check('EXISTS(SELECT 1 FROM workspaces WHERE id=? AND name=?)',
            [id, confirm], 'invalid_request', 'The confirmation must match the workspace name.', 400)]),
        conflict(`NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id NOT IN (SELECT value FROM json_each(?)))
            AND (SELECT count(*) FROM workspace_members WHERE workspace_id=?)=?`,
        [id, JSON.stringify(members), id, members.length], 'conflict', 'Workspace membership changed. Reload and try again.')];
    return guardedWrite(env, { client, actor, id, now, checks, unjoined,
        effects: [...members.flatMap(sub => accessEndStatements(env, id, sub)),
            env.DB.prepare("UPDATE workspaces SET status='closed',closed_at=? WHERE id=?").bind(now, id)],
        event: 'workspace-closed' });
}

export function putWorkspaceHold(env, client, id, value) {
    const reason = boundedText(value, 200, 'reason'), now = Date.now();
    return guardedWrite(env, { client, id, now, checks: [],
        effects: [env.DB.prepare(`INSERT INTO workspace_holds(workspace_id,client_id,reason,created) VALUES(?,?,?,?)
            ON CONFLICT(workspace_id,client_id) DO UPDATE SET reason=excluded.reason`).bind(id, client.id, reason, now)],
        event: 'workspace-updated', audit: 'workspace-hold-put', detail: { reason } });
}

export function deleteWorkspaceHold(env, client, id) {
    return guardedWrite(env, { client, id, checks: [missing('EXISTS(SELECT 1 FROM workspace_holds WHERE workspace_id=? AND client_id=?)',
        [id, client.id], 'Workspace hold not found.')],
        effects: [env.DB.prepare('DELETE FROM workspace_holds WHERE workspace_id=? AND client_id=?').bind(id, client.id)],
        event: 'workspace-updated', audit: 'workspace-hold-deleted' });
}

function resourcePrefixCheck(client, resource) {
    resourceUrl(resource);
    invariant(agentSettings(client).agent_resource_prefixes.some(prefix => underPrefix(resource, prefix)),
        'invalid_target', 'That resource does not belong to this app.', 403);
    return denied('EXISTS(SELECT 1 FROM clients WHERE id=? AND agent_resource_prefixes=?)',
        [client.id, client.agent_resource_prefixes], 'App resource prefixes changed.');
}

export function putWorkspaceResource(env, client, id, resource) {
    const checks = [resourcePrefixCheck(client, resource),
        conflict('NOT EXISTS(SELECT 1 FROM workspace_resources WHERE resource=? AND (workspace_id<>? OR client_id<>?))',
            [resource, id, client.id], 'resource_registered', 'Resource is already registered.')];
    const now = Date.now();
    const writeIf = { sql: 'NOT EXISTS(SELECT 1 FROM workspace_resources WHERE resource=?)', args: [resource] };
    // Insert last so the version, outbox and audit all use the same registration condition.
    const finalEffect = env.DB.prepare(`INSERT INTO workspace_resources(resource,workspace_id,client_id,created)
        SELECT ?,?,?,? WHERE ${writeIf.sql}`).bind(resource, id, client.id, now, ...writeIf.args);
    return guardedWrite(env, { client, id, now, checks, writeIf, finalEffect, event: 'workspace-updated',
        audit: 'workspace-resource-put', detail: { resource } });
}

export function deleteWorkspaceResource(env, client, id, resource) {
    const checks = [resourcePrefixCheck(client, resource),
        missing('EXISTS(SELECT 1 FROM workspace_resources WHERE resource=? AND workspace_id=? AND client_id=?)',
            [resource, id, client.id], 'Workspace resource not found.')];
    const statement = env.DB.prepare('DELETE FROM workspace_resources WHERE resource=? AND workspace_id=? AND client_id=?')
        .bind(resource, id, client.id);
    return guardedWrite(env, { client, id, checks, effects: [statement], event: 'workspace-updated',
        audit: 'workspace-resource-deleted', detail: { resource } });
}

// The console supplies its verified session. App entry points still use a client and a live actor token.
export function adminWorkspaceWrites(env, admin) {
    const actor = { admin, user: { id: admin.user_id, email: admin.email } };
    return {
        create: body => createWorkspace(env, null, actor, { ...body, kind: 'team' }),
        rename: (id, name) => renameWorkspace(env, null, actor, id, name),
        products: (id, body) => setWorkspaceProducts(env, null, actor, id, body),
        invite: (id, body) => inviteToWorkspace(env, null, actor, id, body),
        revokeInvitation: (id, invitationId) => revokeWorkspaceInvitation(env, null, actor, id, invitationId),
        changeRole: (id, sub, role) => setWorkspaceMemberRole(env, null, actor, id, sub, role),
        removeMember: (id, sub) => removeWorkspaceMember(env, null, actor, id, sub),
        close: (id, confirm) => closeWorkspace(env, null, actor, id, confirm)
    };
}
