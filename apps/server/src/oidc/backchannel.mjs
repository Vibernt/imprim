import { outboxDestination } from '../services/outbox-destination.mjs';
import { dispatchOutbox } from '../services/outbox.mjs';
import { assertDelivered, invariant } from '../lib/errors.mjs';
import { signJwt } from './jwt.mjs';
import { expireEvent } from '../services/outbox-expiry.mjs';
import { appSessionLifetimeMs } from './app-sessions.mjs';
import { realmEnvForClient } from '../realms/realm.mjs';
// Capture destinations before deleting associations. RP sessions may outlive identity sessions, up to 30 days.
// sid: one session; except: every session but that one; neither: all of the user's sessions.
export function logoutStatements(env, userId, sid = null, except = null, clientFilter = null) {
    const where = sid !== null ? 'a.user_id=? AND a.sid=?' : except !== null ? 'a.user_id=? AND a.sid<>?' : 'a.user_id=?';
    const args = sid !== null ? [userId, sid] : except !== null ? [userId, except] : [userId];
    // A trusted SQL subquery with bound arguments keeps the client selection inside the caller's transaction.
    const filter = clientFilter ? ` AND a.client_id IN (${clientFilter.sql})` : '';
    args.push(...(clientFilter?.args ?? []));
    const now = Date.now();
    return [
        env.DB.prepare(`INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created)
            SELECT lower(hex(randomblob(16))),a.client_id,a.user_id,CASE WHEN count(*)=1 THEN min(a.sid) ELSE NULL END,c.backchannel_uri,?
            FROM app_sessions a JOIN clients c ON c.id=a.client_id WHERE ${where}${filter} AND a.created>? GROUP BY a.client_id,a.user_id,c.backchannel_uri`)
            .bind(now, ...args, now - appSessionLifetimeMs),
        env.DB.prepare(`DELETE FROM app_sessions AS a WHERE ${where}${filter}`).bind(...args)
    ];
}
export const flushLogouts = env => dispatchOutbox(env, 'logout_outbox', 'human_logout');
export async function deliverLogout(base, message) {
    let env = base;
    const row = await env.DB.prepare('SELECT * FROM logout_outbox WHERE id=?').bind(message.body.event_id).first();
    invariant(row, 'invalid_request', 'Unknown logout event.');
    if (row.delivered_at !== null) return;
    if (await expireEvent(env, 'logout_outbox', row)) return;
    const uri = await outboxDestination(env, 'logout_outbox', row.client_id, row.id);
    env = await realmEnvForClient(base, row.client_id);
    const now = Math.floor(Date.now() / 1000);
    // Logout tokens use the same keys as the app's ID tokens (OpenID Connect Back-Channel Logout 1.0, section 2.6).
    const app = await env.DB.prepare('SELECT id_token_signed_response_alg FROM clients WHERE id=?').bind(row.client_id).first();
    const jwt = await signJwt(env, { iss: env.ISSUER, aud: row.client_id, sub: row.user_id,
        ...(row.sid ? { sid: row.sid } : {}), jti: row.id, iat: now, exp: now + 120,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }, { typ: 'logout+jwt', alg: app?.id_token_signed_response_alg ?? 'ES256' });
    if (await expireEvent(env, 'logout_outbox', row)) return;
    const response = await fetch(uri, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ logout_token: jwt }) });
    if (response.body) await response.body.cancel();
    assertDelivered(response, 'Back-channel logout delivery failed.');
    await env.DB.prepare("UPDATE logout_outbox SET delivered_at=?,delivery_state='delivered' WHERE id=?").bind(Date.now(), row.id).run();
}
