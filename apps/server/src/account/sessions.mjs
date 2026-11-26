import { invariant } from '../lib/errors.mjs';
import { deviceText } from '../lib/device.mjs';
import { t } from '../i18n/index.mjs';
import { appSessionLifetimeMs } from '../oidc/app-sessions.mjs';
import { logoutStatements, flushLogouts } from '../oidc/backchannel.mjs';
import { audit } from '../services/audit.mjs';
import { realmId } from '../realms/realm.mjs';

export async function readSessions(env, session) {
    const now = Date.now();
    const [sessions, apps, browsers] = await Promise.all([
        env.DB.prepare('SELECT sid,method,auth_time,last_seen,device,location FROM sessions WHERE user_id=? AND expires_at>? ORDER BY auth_time DESC LIMIT 50').bind(session.user_id, now).all(),
        env.DB.prepare(`SELECT a.client_id,c.branding,c.initiate_login_uri AS href,max(a.created) AS signed_in
            FROM app_sessions a JOIN clients c ON c.id=a.client_id
            WHERE a.user_id=? AND c.realm_id=? GROUP BY a.client_id ORDER BY signed_in DESC LIMIT 50`).bind(session.user_id, realmId(env)).all(),
        env.DB.prepare('SELECT hash,name,expires_at FROM trusted_devices WHERE user_id=? AND expires_at>? ORDER BY last_used DESC').bind(session.user_id, now).all()
    ]);
    return {
        sessions: sessions.results.map(s => ({ ...s, current: s.sid === session.sid,
            device: s.device ? deviceText(s.device, (id, vars) => t(env, id, vars)) : t(env, 'Unknown device') })),
        apps: apps.results.map(({ client_id, branding, signed_in, href }) => ({ client_id, name: JSON.parse(branding).name || client_id, signed_in, href })),
        browsers: browsers.results
    };
}

export async function endSessions(env, ctx, session, { sid }) {
    invariant(typeof sid === 'string' && sid.length > 0 && sid.length <= 64, 'invalid_request', 'Choose a session to sign out.');
    const others = sid === 'others';
    invariant(others || sid !== session.sid, 'invalid_request', 'This is the browser you’re using. Sign out from your app to end it.');
    const [, associations, ended] = await env.DB.batch([
        ...(others ? logoutStatements(env, session.user_id, null, session.sid) : logoutStatements(env, session.user_id, sid)),
        others ? env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND sid<>?').bind(session.user_id, session.sid)
            : env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND sid=?').bind(session.user_id, sid)
    ]);
    invariant(others || associations.meta.changes || ended.meta.changes, 'not_found', 'Session not found.', 404);
    ctx.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
    await audit(env, 'sessions_revoked', session.user_id, { scope: others ? 'others' : 'one' });
}

export async function endAppSessions(env, ctx, session, { client_id }) {
    invariant(typeof client_id === 'string' && client_id.length > 0 && client_id.length <= 200, 'invalid_request', 'Choose an app to sign out of.');
    const now = Date.now();
    const [, ended] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO logout_outbox(id,client_id,user_id,sid,uri,created) SELECT lower(hex(randomblob(16))),a.client_id,a.user_id,NULL,c.backchannel_uri,?
            FROM app_sessions a JOIN clients c ON c.id=a.client_id WHERE a.user_id=? AND a.client_id=? AND c.realm_id=? AND a.created>? GROUP BY a.client_id`).bind(now, session.user_id, client_id, realmId(env), now - appSessionLifetimeMs),
        env.DB.prepare('DELETE FROM app_sessions WHERE user_id=? AND client_id IN (SELECT id FROM clients WHERE id=? AND realm_id=?)')
            .bind(session.user_id, client_id, realmId(env))
    ]);
    invariant(ended.meta.changes, 'not_found', 'App session not found.', 404);
    ctx.waitUntil(flushLogouts(env).catch(() => audit(env, 'logout_dispatch_failed', null, { pending: true })));
    await audit(env, 'app_signed_out', session.user_id, { client_id });
}

export async function forgetBrowser(env, session, { device }) {
    invariant(typeof device === 'string' && /^[0-9a-f]{64}$/.test(device), 'invalid_request', 'Choose a browser to forget.');
    const removed = await env.DB.prepare('DELETE FROM trusted_devices WHERE hash=? AND user_id=?').bind(device, session.user_id).run();
    invariant(removed.meta.changes, 'not_found', 'Browser not found.', 404);
}
