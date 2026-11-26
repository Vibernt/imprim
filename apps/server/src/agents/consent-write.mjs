import { policyGuard } from './guards.mjs';
import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { requireWorkspaceMember, workspaceConsentGuard } from './policy.mjs';
import { workspaceChoiceGuard } from './workspace-choice.mjs';
import { admissionGuard } from '../services/admission.mjs';
import { replacementGuard, requireReplacement, requireChoice, requireOfferedPermissions, workspacePermissionsGuard } from './consent-choices.mjs';
import { msg } from '../i18n/index.mjs';
import { queueRevocation, revocationStatements } from './revocation.mjs';

// Live grants per person, across apps: each is a consent the person gave, so this only bounds runaway automation (S5).
export const MAX_LIVE_GRANTS = 50;

export async function answerConsent(env, row, context, session, approval) {
    const code = approval && !row.device_hash ? randomToken() : null;
    const codeHash = code ? await sha256(code) : null;
    const now = Date.now(), grantId = approval ? crypto.randomUUID() : null;
    const guard = policyGuard(context.app, row.resource), admission = admissionGuard('s.user_id', context.app.id);
    const workspaceId = approval?.workspaceId ?? null;
    const workspaceAccess = workspaceId === null ? workspaceConsentGuard(env, context.app, row.resource, session.user_id)
        : workspaceChoiceGuard(env, context.app, session.user_id, workspaceId);
    // Claim only while the browser request, session and (if present) device are still live.
    const eligible = `id=? AND browser_hash=? AND expires_at>? AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.hash=? AND s.expires_at>? AND u.status='active' AND u.merged_into IS NULL AND ${admission.sql})
        AND (device_hash IS NULL OR EXISTS(SELECT 1 FROM agent_devices d WHERE d.hash=device_hash AND d.status='pending' AND d.expires_at>?))
        AND ${guard.sql} AND ${workspaceAccess.sql}`;
    const args = [row.id, row.browser_hash, now, session.hash, now, ...admission.args, now, ...guard.args, ...workspaceAccess.args];
    const batch = [];
    const replace = approval?.replace || null, replacement = replacementGuard(env, row, session.user_id, now, replace, workspaceId);
    const permissions = workspacePermissionsGuard(env, row, session.user_id, now, workspaceId, approval?.inherited);
    const belowCap = approval ? `(SELECT count(*) FROM agent_grants
        WHERE user_id=? AND revoked_at IS NULL AND expires_at>? AND id IS NOT ?) < ?` : '1';
    const capArgs = approval ? [session.user_id, now, replace, MAX_LIVE_GRANTS] : [];
    let revocation, revokeIndex;
    if (approval) {
        const { scope, assurance } = approval;
        // Both the new grant and the revocation must happen. The insert requires a still-replaceable grant, and
        // the revocation requires the insert. D1 runs the statements in one transaction without interleaving.
        batch.push(env.DB.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,assurance,
            app_id,user_id,resource,scope,method,google_hd,created,last_used,expires_at,approved_device,approved_location,workspace_id)
            SELECT ?,agent_client_id,?,?,?,client_id,?,resource,?,?,?,?,?,?,?,?,? FROM auth_requests
            WHERE ${eligible} AND ${replacement.sql} AND ${permissions.sql} AND ${belowCap}`)
            .bind(grantId, context.agent.client_name, context.method, assurance, session.user_id, scope, session.method, session.google_hd,
                now, now, now + context.settings.agent_max_grant_days * 86400000, env.REQUEST.device, env.REQUEST.location, workspaceId,
                ...args, ...replacement.args, ...permissions.args, ...capArgs));
        if (code) batch.push(env.DB.prepare(`INSERT INTO agent_codes(hash,grant_id,redirect_uri,challenge,session_hash,expires_at)
            SELECT ?,id,?,?,?,? FROM agent_grants WHERE id=?`).bind(codeHash, row.redirect_uri, row.challenge, session.hash, now + 60000, grantId));
        const grantedScopes = new Set(scope.split(' '));
        const omitted = row.scope.split(' ').some(requested => !grantedScopes.has(requested));
        const detail = { grant_id: grantId, app_id: row.client_id, resource: row.resource, scope,
            ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
            ...(omitted ? { requested_scope: row.scope } : {}),
            ...(replace ? { replaced: replace } : {}) };
        batch.push(env.DB.prepare(`INSERT INTO audit(event,actor,detail,created,realm_id) SELECT 'agent_grant',user_id,?,?,? FROM agent_grants WHERE id=?`)
            .bind(JSON.stringify(detail), now, env.REALM.id, grantId));
        if (replace) {
            revocation = revocationStatements(env, replace, session.user_id, 'agent_replaced', now, grantId);
            batch.push(...revocation.statements);
            revokeIndex = batch.length - 1;
        }
    }
    const granted = approval ? ' AND EXISTS(SELECT 1 FROM agent_grants WHERE id=?)' : '';
    const deleteIndex = batch.length;
    batch.push(env.DB.prepare(`DELETE FROM auth_requests WHERE ${eligible}${granted} RETURNING id`).bind(...args, ...(approval ? [grantId] : [])));
    if (row.device_hash) batch.push(env.DB.prepare(`UPDATE agent_devices SET status=?,grant_id=? WHERE hash=? AND status='pending' AND expires_at>? AND changes()=1`)
        .bind(approval ? 'approved' : 'denied', grantId, row.device_hash, now));
    batch.push(env.DB.prepare(`SELECT ${workspaceAccess.sql} AS allowed, ${replacement.sql} AS replaceable,
        ${permissions.sql} AS still_offered, ${belowCap} AS below_cap`)
        .bind(...workspaceAccess.args, ...replacement.args, ...permissions.args, ...capArgs));
    const written = await env.DB.batch(batch);
    const { allowed, replaceable, still_offered, below_cap } = written.at(-1).results[0];
    if (workspaceId === null) requireWorkspaceMember(allowed === 1);
    else requireChoice(env, row, allowed === 1, msg('Choose an available workspace.'));
    if (approval && written[0].meta.changes !== 1) {
        requireReplacement(env, row, replaceable === 1);
        requireOfferedPermissions(env, row, still_offered === 1);
        invariant(below_cap === 1, 'access_denied', 'You have {count} connected agents, the most allowed. Revoke one in your account, then try again.', 403, { count: MAX_LIVE_GRANTS });
    }
    invariant(written[deleteIndex].results.length === 1 && (!approval || written[0].meta.changes === 1), 'invalid_request',
        'This request was already answered or has expired. Start again from the agent.');
    if (revocation) {
        requireReplacement(env, row, written[revokeIndex].meta.changes === 1);
        queueRevocation(env, env.CTX, revocation.eventId);
    }
    return { code, now };
}
