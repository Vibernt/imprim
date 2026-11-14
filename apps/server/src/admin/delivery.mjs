// The two outboxes share an admin view; only diagnostic fields leave this module.
export async function clientDelivery(env, clientId) {
    const [human, agent, user] = await Promise.all([
        env.DB.prepare(`SELECT id,'human_logout' AS kind,created,delivery_state,last_error
            FROM logout_outbox WHERE client_id=? AND delivered_at IS NULL ORDER BY created DESC,id DESC`).bind(clientId).all(),
        env.DB.prepare(`SELECT id,'agent_revocation' AS kind,created,delivery_state,last_error
            FROM agent_revocation_outbox WHERE app_id=? AND delivered_at IS NULL ORDER BY created DESC,id DESC`).bind(clientId).all(),
        env.DB.prepare(`SELECT id,'user_event' AS kind,created,delivery_state,last_error
            FROM user_event_outbox WHERE client_id=? AND delivered_at IS NULL ORDER BY created DESC,id DESC`).bind(clientId).all()
    ]);
    const events = [...human.results, ...agent.results, ...user.results].sort((a,b) => b.created - a.created || b.id.localeCompare(a.id));
    return { counts: { undelivered: events.filter(row => row.delivery_state !== 'expired').length,
        expired: events.filter(row => row.delivery_state === 'expired').length }, events };
}
