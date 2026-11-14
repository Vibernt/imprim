import { invariant } from '../lib/errors.mjs';
import { expireBacklog } from './outbox-expiry.mjs';
// These table/type pairs are internal constants, never request input.
export async function dispatchOutbox(env, table, type) {
    invariant(['logout_outbox','agent_revocation_outbox','user_event_outbox'].includes(table), 'outbox_config', 'Unknown outbox.', 503);
    await expireBacklog(env, table);
    const cutoff = Date.now() - 60000;
    let after = '';
    // Page through the complete backlog; a large user must not be limited to 100 events/minute.
    for (;;) {
        const { results } = await env.DB.prepare(`SELECT id FROM ${table} WHERE delivered_at IS NULL AND delivery_state!='expired'
            AND (queued_at IS NULL OR queued_at<=?) AND id>? ORDER BY id LIMIT 100`).bind(cutoff, after).all();
        if (!results.length) return;
        invariant(typeof env.LOGOUT_QUEUE?.send === 'function', 'queue_config', 'LOGOUT_QUEUE is required; events remain in the durable outbox.', 503);
        const sent = await Promise.allSettled(results.map(async row => {
            await env.LOGOUT_QUEUE.send({ type, event_id: row.id });
            await env.DB.prepare(`UPDATE ${table} SET queued_at=? WHERE id=?`).bind(Date.now(), row.id).run();
        }));
        const failed = sent.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        after = results.at(-1).id;
    }
}
// Queue one new event from a user request. Failures leave it for the cron dispatcher; the request never waits on
// the system-wide backlog (S13).
export function queueEvent(env, ctx, table, type, id) {
    invariant(['logout_outbox','agent_revocation_outbox','user_event_outbox'].includes(table), 'outbox_config', 'Unknown outbox.', 503);
    if (!id) return;
    ctx?.waitUntil((async () => {
        invariant(typeof env.LOGOUT_QUEUE?.send === 'function', 'queue_config', 'LOGOUT_QUEUE is required.', 503);
        await env.LOGOUT_QUEUE.send({ type, event_id: id });
        await env.DB.prepare(`UPDATE ${table} SET queued_at=? WHERE id=? AND queued_at IS NULL`).bind(Date.now(), id).run();
    })().catch(error => console.error(JSON.stringify({ type: 'event_queue_deferred', table, code: error?.code || 'queue_failed' }))));
}
export async function deliveryStatus(env) {
    const [human, agent, missing] = await Promise.all([
        env.DB.prepare("SELECT count(*) AS pending,min(created) AS oldest FROM logout_outbox WHERE delivered_at IS NULL AND delivery_state!='expired'").first(),
        env.DB.prepare("SELECT count(*) AS pending,min(created) AS oldest FROM agent_revocation_outbox WHERE delivered_at IS NULL AND delivery_state!='expired'").first(),
        env.DB.prepare(`SELECT o.client_id FROM logout_outbox o LEFT JOIN clients c ON c.id=o.client_id
            WHERE o.delivered_at IS NULL AND o.delivery_state!='expired' AND c.backchannel_uri IS NULL
            UNION SELECT o.app_id AS client_id FROM agent_revocation_outbox o LEFT JOIN clients c ON c.id=o.app_id
            WHERE o.delivered_at IS NULL AND o.delivery_state!='expired' AND c.backchannel_uri IS NULL ORDER BY client_id`).all()
    ]);
    return { human, agent, clients_missing_backchannel: missing.results.map(row => row.client_id) };
}

export async function dispatchDeliveries(env) {
    const results = await Promise.allSettled([
        dispatchOutbox(env, 'logout_outbox', 'human_logout'),
        dispatchOutbox(env, 'agent_revocation_outbox', 'agent_revocation'),
        dispatchOutbox(env, 'user_event_outbox', 'user_event')
    ]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
}
