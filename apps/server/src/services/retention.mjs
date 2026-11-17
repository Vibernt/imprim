// Thirty days after delivery allows incident review and delayed queue replay investigation.
// Audit rows remain append-only; pending deliveries are never removed by retention.
const deliveredRetentionMs = 30 * 86400000;
export async function cleanDeliveryHistory(env, now = Date.now()) {
    for (const table of ['logout_outbox','agent_revocation_outbox','user_event_outbox','workspace_event_outbox'])
        await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (
            SELECT id FROM ${table} WHERE delivered_at<? ORDER BY delivered_at,id LIMIT 500)`)
            .bind(now - deliveredRetentionMs).run();
    // User and workspace events that expired undelivered go after the same 30 days.
    for (const table of ['user_event_outbox','workspace_event_outbox'])
        await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE delivery_state='expired' AND created<? LIMIT 500)`)
            .bind(now - deliveredRetentionMs - 86400000).run();
}
