// User lifecycle events: every app that admitted the person gets a signed security event token (RFC 8417) on its
// back-channel URI, through the durable outbox, queue, retries and jti deduplication used for logout.
import { outboxDestination } from './outbox-destination.mjs';
import { expireEvent } from './outbox-expiry.mjs';
import { assertDelivered, invariant } from '../lib/errors.mjs';
import { signAgentJwt } from '../agents/grants.mjs';
import { realmEnvForClient } from '../realms/realm.mjs';
export const USER_EVENTS = ['user-updated', 'user-blocked', 'user-unblocked', 'user-deleted', 'user-merged', 'mfa-reset'];
// Rows for the outbox, in the caller's batch. Put them before statements that remove the person's admissions.
// Only apps that opted in (user_events on) and have a back-channel URI receive them. Payloads name what changed,
// never the new values: an app reads those from its next ID token or userinfo, under the scopes it was granted.
// `onlyIf` is an extra SQL condition (with its args) that must hold when the batch runs, such as a status check.
export function userEventStatements(env, userId, event, payload = {}, onlyIf = null) {
    invariant(USER_EVENTS.includes(event), 'event_config', 'Unknown user event.', 503);
    return [env.DB.prepare(`INSERT INTO user_event_outbox(id,client_id,user_id,event,payload,uri,created)
        SELECT lower(hex(randomblob(16))),a.client_id,a.user_id,?,?,c.backchannel_uri,? FROM client_admissions a JOIN clients c ON c.id=a.client_id
        WHERE a.user_id=? AND c.user_events='on' AND c.backchannel_uri IS NOT NULL${onlyIf ? ` AND ${onlyIf.sql}` : ''}`)
        .bind(event, JSON.stringify(payload), Date.now(), userId, ...(onlyIf?.args ?? []))];
}
const userEventType = (issuer, event) => `${issuer}/events/${event}`;
export async function deliverUserEvent(base, message) {
    const row = await base.DB.prepare('SELECT * FROM user_event_outbox WHERE id=?').bind(message.body.event_id).first();
    invariant(row, 'invalid_request', 'Unknown user event.');
    if (row.delivered_at !== null) return;
    if (await expireEvent(base, 'user_event_outbox', row)) return;
    const uri = await outboxDestination(base, 'user_event_outbox', row.client_id, row.id);
    const env = await realmEnvForClient(base, row.client_id), now = Math.floor(Date.now() / 1000);
    const jwt = await signAgentJwt(env, { iss: env.ISSUER, aud: row.client_id, sub: row.user_id, jti: row.id, iat: now, exp: now + 300,
        // toe: when the change happened (RFC 8417), so an app applies retried or reordered events last-writer-wins.
        toe: Math.floor(row.created / 1000), events: { [userEventType(env.ISSUER, row.event)]: JSON.parse(row.payload) } }, 'secevent+jwt');
    if (await expireEvent(base, 'user_event_outbox', row)) return;
    const response = await fetch(uri, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ event_token: jwt }) });
    if (response.body) await response.body.cancel();
    assertDelivered(response, 'User event delivery failed.');
    await base.DB.prepare("UPDATE user_event_outbox SET delivered_at=?,delivery_state='delivered' WHERE id=?").bind(Date.now(), row.id).run();
}
