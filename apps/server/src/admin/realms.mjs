// Platform administration of realms and their admin rosters. Every write runs through mutationEnvironment.
import { invariant } from '../lib/errors.mjs';
import { validateRealmConfig, forgetRealms } from '../realms/realm.mjs';
import { normalizeEmail } from '../services/admission.mjs';
import { auditStatement } from './auth.mjs';
export async function listRealms(env) {
    const { results } = await env.DB.prepare('SELECT id,issuer,display_name,config,status,version,created FROM realms ORDER BY id').all();
    const admins = (await env.DB.prepare('SELECT realm_id,email,role FROM admins ORDER BY realm_id,email').all()).results;
    return results.map(row => ({ ...row, config: JSON.parse(row.config), admins: admins.filter(admin => admin.realm_id === row.id).map(({ email, role }) => ({ email, role })) }));
}
function validIssuer(value) {
    let url;
    try { url = new URL(value); } catch { invariant(false, 'invalid_request', 'issuer must be an https origin.'); }
    invariant(url.protocol === 'https:' && url.origin === value, 'invalid_request', 'issuer must be a canonical https origin.');
    return value;
}
export async function saveRealm(env, actor, id, input) {
    const allowed = ['id', 'issuer', 'display_name', 'config', 'status', 'version'];
    invariant(input && Object.keys(input).every(key => allowed.includes(key)), 'invalid_request', 'Unknown realm field.');
    const old = id ? await env.DB.prepare('SELECT * FROM realms WHERE id=?').bind(id).first() : null;
    invariant(!id || old, 'not_found', 'Realm not found.', 404);
    const value = { issuer: old?.issuer ?? null, display_name: old?.display_name, config: old ? JSON.parse(old.config) : {}, status: old?.status ?? 'active', ...input };
    const realm = id || value.id;
    invariant(typeof realm === 'string' && /^[a-z0-9-]{1,40}$/.test(realm), 'invalid_request', 'Realm id: 1-40 lowercase letters, digits or hyphens.');
    validIssuer(value.issuer);
    invariant(typeof value.display_name === 'string' && value.display_name.trim() && value.display_name.length <= 100, 'invalid_request', 'display_name: 1-100 characters.');
    invariant(['active', 'disabled'].includes(value.status), 'invalid_request', 'status is active or disabled.');
    invariant(realm !== env.REALM.id || value.status === 'active', 'invalid_request', 'You cannot disable the realm you are signed in to.');
    validateRealmConfig(value.config);
    if (old) invariant(input.version === old.version, 'conflict', 'Realm changed; reload before editing.', 409);
    const statement = old
        ? env.DB.prepare('UPDATE realms SET issuer=?,display_name=?,config=?,status=?,version=version+1 WHERE id=? AND version=?')
            .bind(value.issuer, value.display_name, JSON.stringify(value.config), value.status, realm, old.version)
        : env.DB.prepare('INSERT INTO realms(id,issuer,display_name,config,status,created) VALUES(?,?,?,?,?,?)')
            .bind(realm, value.issuer, value.display_name, JSON.stringify(value.config), value.status, Date.now());
    try {
        const [result] = await env.DB.batch([statement, auditStatement(env, actor, old ? 'admin_realm_update' : 'admin_realm_create', realm, { fields: Object.keys(input) })]);
        invariant(result.meta.changes === 1, 'conflict', 'Realm changed; reload before editing.', 409);
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) invariant(false, 'conflict', 'That realm id or issuer is already in use.', 409);
        throw error;
    }
    forgetRealms(env);
    return { realm: (await listRealms(env)).find(row => row.id === realm) };
}
// Adds, changes or removes (role: null) one admin of a realm. A platform admin cannot remove their own role.
export async function saveAdmin(env, actor, realm, input) {
    invariant(await env.DB.prepare('SELECT 1 FROM realms WHERE id=?').bind(realm).first(), 'not_found', 'Realm not found.', 404);
    const email = normalizeEmail(input?.email);
    invariant([null, 'platform', 'realm'].includes(input.role ?? null), 'invalid_request', 'role is platform, realm or null.');
    const self = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(actor).first();
    invariant(!(realm === env.REALM.id && self?.email === email), 'invalid_request', 'Administrators cannot change their own role.');
    const statement = input.role
        ? env.DB.prepare('INSERT INTO admins(realm_id,email,role,created,created_by) VALUES(?,?,?,?,?) ON CONFLICT(realm_id,email) DO UPDATE SET role=excluded.role').bind(realm, email, input.role, Date.now(), actor)
        : env.DB.prepare('DELETE FROM admins WHERE realm_id=? AND email=?').bind(realm, email);
    await env.DB.batch([statement, auditStatement(env, actor, input.role ? 'admin_roster_set' : 'admin_roster_remove', realm, { role: input.role ?? null })]);
    return { realm, email, role: input.role ?? null };
}
