import { invariant } from '../lib/errors.mjs';

export const deliveryWindowMs = 24 * 60 * 60 * 1000;
const tables = { logout_outbox: ['client_id','human_logout'], agent_revocation_outbox: ['app_id','agent_revocation'], user_event_outbox: ['client_id','user_event'] };

export async function expireEvent(env, table, row, now = Date.now()) {
    const config = tables[table];
    invariant(config, 'outbox_config', 'Unknown outbox.', 503);
    if (row.delivery_state === 'expired') return true;
    if (row.delivered_at !== null || now - row.created < deliveryWindowMs) return false;
    const [clientColumn, kind] = config;
    const detail = JSON.stringify({ client_id: row[clientColumn], event_kind: kind, event_id: row.id });
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
            SELECT 'backchannel_expired',NULL,?,?,?,(SELECT realm_id FROM clients WHERE id=?) FROM ${table}
            WHERE id=? AND delivered_at IS NULL AND delivery_state!='expired'`).bind(row[clientColumn], detail, now, row[clientColumn], row.id),
        env.DB.prepare(`UPDATE ${table} SET delivery_state='expired',last_error=coalesce(last_error,'Delivery window exceeded.')
            WHERE id=? AND delivered_at IS NULL AND delivery_state!='expired'`).bind(row.id)
    ]);
    return true;
}

export async function expireBacklog(env, table, now = Date.now()) {
    invariant(tables[table], 'outbox_config', 'Unknown outbox.', 503);
    let after = '';
    for (;;) {
        const { results } = await env.DB.prepare(`SELECT * FROM ${table}
            WHERE delivered_at IS NULL AND delivery_state!='expired' AND created<=? AND id>?
            ORDER BY id LIMIT 100`).bind(now - deliveryWindowMs, after).all();
        if (!results.length) return;
        for (const row of results) await expireEvent(env, table, row, now);
        after = results.at(-1).id;
    }
}

export async function recordDeliveryError(env, table, id, error) {
    invariant(tables[table], 'outbox_config', 'Unknown outbox.', 503);
    const message = error?.code === 'backchannel_config' ? 'Client needs a current back-channel URI.'
        : error?.code === 'backchannel_failed' ? 'Back-channel endpoint refused delivery' + (error.httpStatus ? ` (HTTP ${error.httpStatus}).` : '.')
            : 'Back-channel delivery failed: ' + (error?.name === 'TimeoutError' ? 'timeout.' : 'network or signing error.');
    await env.DB.prepare(`UPDATE ${table} SET last_error=? WHERE id=? AND delivered_at IS NULL AND delivery_state!='expired'`)
        .bind(message, id).run();
}
