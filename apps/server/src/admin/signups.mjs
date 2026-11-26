import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { audit } from '../services/audit.mjs';
import { dispatchDeliveries } from '../services/outbox.mjs';
import { signupAccessGuard, signupOwnershipGuard, signupSettingsGuard } from '../workspaces/signup-guards.mjs';
import { createSignupWorkspace } from '../workspaces/signup.mjs';
import { pendingSignupSql, signupAlreadyDecided, signupRequestLifetime } from '../workspaces/signup-requests.mjs';
import { notifySignupDecision } from '../workspaces/signup-email.mjs';

const statuses = ['pending', 'approved', 'declined', 'expired'];
const pageSize = 50;
const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);

export async function signupSummary(env) {
    return env.DB.prepare("SELECT count(*) AS pending FROM signup_requests WHERE realm_id=? AND status='pending' AND verified_at>?")
        .bind(realmId(env), Date.now() - signupRequestLifetime).first();
}

export async function listSignupRequests(env, query) {
    const realm = realmId(env), status = query.get('status') ?? 'pending', before = query.get('before');
    invariant(statuses.includes(status), 'invalid_request', 'Invalid sign-up request status.');
    invariant(before === null || validId(before), 'invalid_request', 'Invalid page cursor.');
    const { results } = await env.DB.prepare(`SELECT s.id,s.email,s.workspace_name,s.product,s.client_id,s.status,s.created,s.reason,
        json_extract(c.branding,'$.name') AS app_name
        FROM signup_requests s LEFT JOIN clients c ON c.id=s.client_id AND c.realm_id=s.realm_id
        WHERE s.realm_id=? AND s.status=? AND (s.status!='pending' OR s.verified_at>?)
            AND (? IS NULL OR (s.created,s.id)<
            (SELECT created,id FROM signup_requests WHERE realm_id=? AND id=?))
        ORDER BY s.created DESC,s.id DESC LIMIT ?`)
        .bind(realm, status, Date.now() - signupRequestLifetime, before, realm, before, pageSize + 1).all();
    return { requests: results.slice(0, pageSize), next: results.length > pageSize ? results[pageSize - 1].id : null };
}

function declineReason(value) {
    if (value === undefined) return null;
    invariant(typeof value === 'string' && !value.includes('\0') && [...value.trim()].length <= 500,
        'invalid_request', 'Enter a reason up to 500 characters.');
    return value.trim() || null;
}

const recordedDecision = (env, pending, now, actor, status, reason, checks = []) =>
    env.DB.prepare(`UPDATE signup_requests SET status=?, decided_at=?, decided_by=?, reason=? WHERE ${pendingSignupSql}
        ${checks.map(check => `AND (${check.sql})`).join(' ')}`)
        .bind(status, now, actor, reason, ...pending, ...checks.flatMap(check => check.args));

async function decline(env, pending, now, actor, reason, checks) {
    const [changed] = await env.DB.batch([
        recordedDecision(env, pending, now, actor, 'declined', reason, checks),
        env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
            SELECT 'signup_request_declined',?,?,?,?,? WHERE changes()=1`)
            .bind(actor, pending[1], JSON.stringify({ reason }), now, pending[0])
    ]);
    invariant(changed.meta.changes === 1, 'conflict', 'The request or eligibility changed. Reload and try again.', 409);
}

async function approve(env, client, request, pending, now, actor) {
    const settings = signupSettingsGuard(env, client);
    const ownership = signupOwnershipGuard(env, client, request.email);
    const access = signupAccessGuard(env, client, request.email, now);
    const live = await env.DB.prepare(`SELECT (${settings.sql}) AS enabled, (${ownership.sql}) AS available, (${access.sql}) AS eligible`)
        .bind(...settings.args, ...ownership.args, ...access.args).first();
    invariant(live.enabled, settings.code, settings.message, settings.status);
    if (!live.available || !live.eligible) {
        const failed = live.available ? access : ownership;
        const reason = live.available ? 'The applicant already has access or an active invitation.' : 'The applicant already owns a sign-up workspace for this product.';
        await decline(env, pending, now, actor, reason, [settings, { ...failed, sql: `NOT (${failed.sql})` }]);
        // The applicant can already sign in, so no "declined" notice is sent; the console shows the reason.
        return { status: 'declined', reason, automatic: true };
    }
    const workspace = await createSignupWorkspace(env, client, request, {
        now, approver: actor, requestId: request.id,
        checks: [{ sql: `EXISTS(SELECT 1 FROM signup_requests WHERE ${pendingSignupSql})`, args: pending,
            code: 'conflict', message: signupAlreadyDecided, status: 409 }],
        decisionEffects: [recordedDecision(env, pending, now, actor, 'approved', null),
            env.DB.prepare('INSERT INTO admin_assertions(ok) VALUES(changes()=1)')]
    });
    return { status: 'approved', workspace_id: workspace.workspace_id };
}

export async function decideSignupRequest(env, ctx, actor, id, action, body) {
    invariant(validId(id), 'not_found', 'Sign-up request not found.', 404);
    const realm = realmId(env), now = Date.now(), pending = [realm, id, now - signupRequestLifetime];
    const request = await env.DB.prepare('SELECT * FROM signup_requests WHERE realm_id=? AND id=?').bind(realm, id).first();
    invariant(request, 'not_found', 'Sign-up request not found.', 404);
    invariant(request.status === 'pending' && request.verified_at > pending[2], 'conflict', signupAlreadyDecided, 409);
    const client = await env.DB.prepare('SELECT * FROM clients WHERE realm_id=? AND id=?').bind(realm, request.client_id).first();
    let result;
    if (action === 'approve') {
        invariant(client?.product === request.product, 'conflict', 'The app or product has changed.', 409);
        result = await approve(env, client, request, pending, now, actor);
    } else {
        const reason = declineReason(body.reason);
        await decline(env, pending, now, actor, reason);
        result = { status: 'declined', reason };
    }
    if (result.status === 'approved') ctx.waitUntil(dispatchDeliveries(env).catch(() => audit(env, 'admin_dispatch_failed', actor, { pending: true })));
    const { automatic, ...decision } = result;
    const delivery = automatic ? { state: 'skipped' } : await notifySignupDecision(env, client, request, result.status, actor);
    return { ...decision, delivery };
}
