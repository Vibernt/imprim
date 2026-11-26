import { confirmedFactors } from '../auth/mfa.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';

export async function users(env, query) {
    const search = (query.get('q') || '').slice(0, 254), cursor = query.get('before') || '\uffff';
    const where = 'u.realm_id=? AND (instr(lower(u.email),lower(?))>0 OR u.id=?)';
    const args = [realmId(env), search, search];
    const [page, count] = await env.DB.batch([
        env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.status,u.merged_into,u.created,
            (SELECT max(a.created) FROM audit a WHERE a.realm_id=u.realm_id AND a.actor=u.id
                AND a.event IN ('sign_in','admin_sign_in')) AS last_sign_in
            FROM users u WHERE ${where} AND u.id<? ORDER BY u.id DESC LIMIT 51`).bind(...args, cursor),
        env.DB.prepare(`SELECT count(*) AS total FROM users u WHERE ${where}`).bind(...args)
    ]);
    const rows = page.results;
    return { users: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null, total: count.results[0].total };
}

export async function userDetail(env, id) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE id=? AND realm_id=?').bind(id, realmId(env)).first();
    invariant(user, 'not_found', 'User not found.', 404);
    const [identities, sessions, grants, methods, factors] = await Promise.all([
        env.DB.prepare('SELECT provider,provider_id,login,created FROM user_identities WHERE user_id=? ORDER BY provider,provider_id').bind(id).all(),
        env.DB.prepare('SELECT sid,method,auth_time,expires_at FROM sessions WHERE user_id=? ORDER BY auth_time DESC LIMIT 100').bind(id).all(),
        env.DB.prepare('SELECT id,client_id,app_id,resource,scope,created,last_used,expires_at,revoked_at FROM agent_grants WHERE user_id=? ORDER BY created DESC LIMIT 100').bind(id).all(),
        env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM user_passwords WHERE user_id=?1) AS password,
            EXISTS(SELECT 1 FROM recovery_codes WHERE user_id=?1 AND used_at IS NULL) AS recovery,
            (SELECT count(*) FROM agent_grants WHERE user_id=?1) AS agent_grant_count`).bind(id).first(),
        confirmedFactors(env, id)
    ]);
    return {
        ...user, identities: identities.results, sessions: sessions.results, grants: grants.results,
        sign_in_methods: [...new Set([
            ...(user.email_verified ? ['email'] : []), ...(methods.password ? ['password'] : []),
            ...(factors.some(factor => factor.type === 'passkey') ? ['passkey'] : []),
            ...identities.results.map(identity => identity.provider)
        ])],
        verification_methods: [...new Set([...factors.map(factor => factor.type), ...(methods.recovery ? ['recovery'] : [])])],
        agent_grant_count: methods.agent_grant_count
    };
}
