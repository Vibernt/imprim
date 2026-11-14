import { invariant } from '../lib/errors.mjs';
// Captured URI is diagnostic only. Every attempt uses the client's current registration.
export async function outboxDestination(env, table, clientId, eventId) {
    invariant(['logout_outbox','agent_revocation_outbox'].includes(table), 'outbox_config', 'Unknown outbox.', 503);
    const client = await env.DB.prepare('SELECT backchannel_uri FROM clients WHERE id=?').bind(clientId).first();
    const uri = client?.backchannel_uri;
    await env.DB.prepare(`UPDATE ${table} SET delivery_state=? WHERE id=? AND delivered_at IS NULL AND delivery_state!='expired'`)
        .bind(uri ? 'pending' : 'missing_uri', eventId).run();
    invariant(uri, 'backchannel_config', 'Client needs a current back-channel URI; event retained.', 503);
    return uri;
}
