import { outboxDestination } from '../services/outbox-destination.mjs';
import { queueEvent } from '../services/outbox.mjs';
import { assertDelivered, invariant } from '../lib/errors.mjs';
import { signAgentJwt } from './grants.mjs';
import { expireEvent } from '../services/outbox-expiry.mjs';
import { realmEnvForClient } from '../realms/realm.mjs';
export async function revokeGrant(env, id, userId, reason = 'agent_revoke') {
    const now = Date.now(), eventId = crypto.randomUUID();
    const where = 'id=? AND user_id=? AND revoked_at IS NULL';
    // Durable outbox and revocation are one transaction. Queue outages cannot restore access. The row is written even
    // when the app has no back-channel URI yet, so the loss shows up as missing_uri instead of vanishing (S17).
    const result = await env.DB.batch([
        env.DB.prepare(`INSERT INTO agent_revocation_outbox(id,grant_id,app_id,user_id,resource,uri,created)
            SELECT ?,g.id,g.app_id,g.user_id,g.resource,coalesce(c.backchannel_uri,''),? FROM agent_grants g JOIN clients c ON c.id=g.app_id
            WHERE g.id=? AND g.user_id=? AND g.revoked_at IS NULL`).bind(eventId, now, id, userId),
        env.DB.prepare(`INSERT INTO audit(event,actor,detail,created,realm_id) SELECT ?,user_id,?,?,(SELECT realm_id FROM clients WHERE id=app_id) FROM agent_grants WHERE ${where}`)
            .bind(reason, JSON.stringify({ grant_id: id }), now, id, userId),
        env.DB.prepare(`UPDATE agent_grants SET revoked_at=? WHERE ${where}`).bind(now, id, userId)
    ]);
    return result[2].meta.changes === 1 ? eventId : null;
}
export const queueRevocation = (env, ctx, eventId) => queueEvent(env, ctx, 'agent_revocation_outbox', 'agent_revocation', eventId);
// RFC 8417 security event. The event type is issuer-relative, so each realm names its own events.
const revocationEventType = issuer => `${issuer}/events/agent-revoked`;
export async function deliverRevocation(base, message) {
    let env = base;
    const row = await env.DB.prepare('SELECT * FROM agent_revocation_outbox WHERE id=?').bind(message.body.event_id).first();
    invariant(row, 'invalid_request', 'Unknown revocation event.');
    if (row.delivered_at !== null) return;
    if (await expireEvent(env, 'agent_revocation_outbox', row)) return;
    const uri = await outboxDestination(env, 'agent_revocation_outbox', row.app_id, row.id);
    env = await realmEnvForClient(base, row.app_id);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signAgentJwt(env, { iss: env.ISSUER, aud: row.app_id, sub: row.user_id, jti: row.id, iat: now, exp: now + 300,
        grant_id: row.grant_id, resource: row.resource, events: { [revocationEventType(env.ISSUER)]: {} } }, 'secevent+jwt');
    if (await expireEvent(env, 'agent_revocation_outbox', row)) return;
    const response = await fetch(uri, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ revocation_token: jwt }) });
    if (response.body) await response.body.cancel();
    assertDelivered(response, 'Back-channel delivery failed.');
    await env.DB.prepare("UPDATE agent_revocation_outbox SET delivered_at=?,delivery_state='delivered' WHERE id=?").bind(Date.now(), row.id).run();
}
