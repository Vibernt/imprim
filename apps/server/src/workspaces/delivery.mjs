import { signAgentJwt } from '../agents/grants.mjs';
import { assertDelivered, invariant } from '../lib/errors.mjs';
import { realmEnvForClient } from '../realms/realm.mjs';
import { outboxDestination } from '../services/outbox-destination.mjs';
import { expireEvent } from '../services/outbox-expiry.mjs';

const table = 'workspace_event_outbox';
const memberEvents = ['workspace-member-added', 'workspace-member-removed', 'workspace-role-changed'];
export async function deliverWorkspaceEvent(base, message) {
    const row = await base.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(message.body.event_id).first();
    invariant(row, 'invalid_request', 'Unknown workspace event.');
    if (row.delivered_at !== null || await expireEvent(base, table, row)) return;
    const uri = await outboxDestination(base, table, row.client_id, row.id);
    const env = await realmEnvForClient(base, row.client_id), now = Math.floor(Date.now() / 1000);
    const jwt = await signAgentJwt(env, {
        iss: env.ISSUER, aud: row.client_id, jti: row.id, iat: now, exp: now + 300, toe: Math.floor(row.created / 1000),
        ...(memberEvents.includes(row.event) ? { sub: row.user_id } : {}),
        events: { [`${env.ISSUER}/events/${row.event}`]: JSON.parse(row.payload) }
    }, 'secevent+jwt');
    if (await expireEvent(base, table, row)) return;
    const response = await fetch(uri, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ workspace_token: jwt }) });
    if (response.body) await response.body.cancel();
    assertDelivered(response, 'Workspace event delivery failed.');
    await base.DB.prepare(`UPDATE ${table} SET delivered_at=?,delivery_state='delivered' WHERE id=?`).bind(Date.now(), row.id).run();
}
