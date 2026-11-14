// Each row names its realm. Requests always have one; queue and cron work pass the event's realm in env.
export async function audit(env, event, actor = null, detail = {}) {
    await env.DB.prepare('INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,?,?,?)')
        .bind(event, actor, JSON.stringify(detail), Date.now(), env.REALM?.id ?? null).run();
}
