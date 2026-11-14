export const appSessionLifetimeMs = 30 * 86400000;

export async function cleanExpiredAppSessions(env, now = Date.now()) {
    await env.DB.prepare(`DELETE FROM app_sessions WHERE rowid IN (
        SELECT rowid FROM app_sessions WHERE created<=? ORDER BY created,rowid LIMIT 500)`)
        .bind(now - appSessionLifetimeMs).run();
}
