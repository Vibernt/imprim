import { cleanDeliveryHistory } from './retention.mjs';
import { dispatchDeliveries } from './outbox.mjs';
import { deliverLogout } from '../oidc/backchannel.mjs';
import { deliverRevocation } from '../agents/revocation.mjs';
import { keySweep } from '../oidc/keys.mjs';
import { recordDeliveryError } from './outbox-expiry.mjs';
import { cleanExpiredAppSessions } from '../oidc/app-sessions.mjs';
import { configuredRealms, realmEnv } from '../realms/realm.mjs';
export async function scheduled(env) {
    // Delivery is independent of key maintenance: a bad sealing key must not stop enqueueing.
    const results = await Promise.allSettled([dispatchDeliveries(env), maintain(env)]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
}
async function maintain(env) {
    // Each realm rotates its own ring; one realm's bad key never stops another's sweep.
    const sweeps = await Promise.allSettled((await configuredRealms(env)).map(realm => keySweep(realmEnv(env, realm))));
    const now = Date.now();
    await cleanDeliveryHistory(env, now);
    await cleanExpiredAppSessions(env, now);
    for (const table of ['magic_links', 'oauth_states', 'auth_requests', 'codes', 'access_tokens', 'consumed_codes', 'sessions', 'invitations', 'rate_limits', 'agent_codes', 'agent_metadata_cache', 'agent_consumed_codes', 'agent_assertions'])
        await env.DB.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).bind(now).run();
    // Retain expired device codes for a day so pollers receive expired_token after the sweep.
    await env.DB.prepare('DELETE FROM agent_devices WHERE expires_at<=?').bind(now - 86400000).run();
    await env.DB.prepare('DELETE FROM agent_clients WHERE last_used<=?').bind(now - 30 * 86400000).run();
    await sweepGrants(env, now);
    const failed = sweeps.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
}
export const SPENT_REFRESH_KEEP_MS = 7 * 86400000, ENDED_GRANT_KEEP_MS = 30 * 86400000, AUDIT_RETENTION_MS = 400 * 86400000;
// Bounded growth (S5): spent refresh tokens keep reuse detection for a week; ended grants stay listed at /account for
// 30 days; audit rows are kept 400 days (the migration's trigger refuses younger deletes). Each pass is batched.
export async function sweepGrants(env, now = Date.now()) {
    await env.DB.prepare(`DELETE FROM agent_refresh_tokens WHERE rowid IN (SELECT rowid FROM agent_refresh_tokens
        WHERE spent_at IS NOT NULL AND spent_at<=? LIMIT 5000)`).bind(now - SPENT_REFRESH_KEEP_MS).run();
    const ended = `SELECT id FROM agent_grants WHERE (revoked_at IS NOT NULL AND revoked_at<=?) OR expires_at<=? LIMIT 500`;
    await env.DB.batch([
        env.DB.prepare(`DELETE FROM agent_devices WHERE grant_id IN (${ended})`).bind(now - ENDED_GRANT_KEEP_MS, now - ENDED_GRANT_KEEP_MS),
        env.DB.prepare(`DELETE FROM agent_grants WHERE id IN (${ended})`).bind(now - ENDED_GRANT_KEEP_MS, now - ENDED_GRANT_KEEP_MS)
    ]);
    await env.DB.prepare('DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE created<=? ORDER BY id LIMIT 5000)').bind(now - AUDIT_RETENTION_MS - 86400000).run();
}
export async function queue(batch, env) {
    await Promise.all(batch.messages.map(async message => {
        if (!['agent_revocation','human_logout'].includes(message.body?.type)) { message.retry({ delaySeconds: 3600 }); return; }
        try { await (message.body.type === 'human_logout' ? deliverLogout : deliverRevocation)(env, message); message.ack(); }
        catch (error) {
            const table = message.body.type === 'human_logout' ? 'logout_outbox' : 'agent_revocation_outbox';
            await recordDeliveryError(env, table, message.body.event_id, error);
            message.retry({ delaySeconds: 10 });
        }
    }));
}
