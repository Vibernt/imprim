// Ported from Assay session.mjs and magic.mjs; host-only cookies, 30 days, strict Origin for mutations.
import { randomToken, sha256, safeEqual } from '../lib/crypto.mjs';
import { isAdmin } from '../services/admission.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
export const SESSION_COOKIE = '__Host-vi_session', CSRF_COOKIE = '__Host-vi_csrf', BROWSER_COOKIE = '__Host-vi_browser';
// A duplicate is refused only for the names this server reads. A sibling host's cookies cannot break sign-in (S19).
const READ = /^__Host-vi_/;
export function cookies(request) {
    const result = {};
    for (const item of (request.headers.get('cookie') || '').split(';')) {
        const index = item.indexOf('=');
        if (index < 0) continue;
        const key = item.slice(0, index).trim();
        if (!READ.test(key)) continue;
        invariant(!Object.hasOwn(result, key), 'invalid_request', 'Duplicate cookies.');
        result[key] = item.slice(index + 1).trim();
    }
    return result;
}
export const cookie = (name, value, maxAge, httpOnly = true) => `${name}=${value}; Path=/; Secure; SameSite=Lax; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}`;
export function assertOrigin(request, env) {
    invariant(request.headers.get('origin') === env.ISSUER, 'origin', 'Same-origin request required.', 403);
}
export async function getSession(request, env) {
    const value = cookies(request)[SESSION_COOKIE];
    if (!value) return null;
    return sessionByHash(env, await sha256(value));
}
export async function sessionByHash(env, hash) {
    // A session belongs to the realm of its user; another realm's host never accepts it.
    return env.DB.prepare(`SELECT s.*,u.email,u.email_verified FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.hash=? AND s.expires_at>? AND u.status='active' AND u.merged_into IS NULL AND u.realm_id=?`)
        .bind(hash, Date.now(), realmId(env)).first();
}
export async function requireCsrf(request, env, session, supplied) {
    assertOrigin(request, env);
    const csrf = supplied || request.headers.get('x-csrf-token');
    invariant(session && csrf && cookies(request)[CSRF_COOKIE] === csrf && await safeEqual(await sha256(csrf), session.csrf_hash),
        'csrf', 'A valid CSRF token is required.', 403);
}
// RFC 8176 where a value exists ('pwd'); otherwise the method name, as before, so existing apps see no change.
export const amrFor = method => [method === 'password' ? 'pwd' : method];
export async function issueSession(env, user, method, googleHd = null, admin = false) {
    invariant(user?.status === 'active' && !user.merged_into, 'access_denied', 'Account unavailable.', 403);
    const token = randomToken(), csrf = randomToken(), hash = await sha256(token);
    const sid = crypto.randomUUID(), now = Date.now();
    invariant(!admin || (method === 'email' && await isAdmin(env, user.email)), 'access_denied', 'Administrator magic link required.', 403);
    const insert = env.DB.prepare(`INSERT INTO sessions(hash,sid,user_id,csrf_hash,method,auth_time,expires_at,google_hd,admin_until,amr)
        SELECT ?,?,id,?,?,?,?,?,?,? FROM users WHERE id=? AND realm_id=? AND status='active' AND merged_into IS NULL`)
        .bind(hash, sid, await sha256(csrf), method, Math.floor(now / 1000), now + 30 * 86400000, googleHd, admin ? now + 3600000 : null, JSON.stringify(amrFor(method)), user.id, realmId(env));
    await env.DB.batch([insert, ...(admin ? [env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
        SELECT 'admin_sign_in',user_id,user_id,'{"method":"email"}',?,? FROM sessions WHERE hash=?`).bind(now, realmId(env), hash)] : [])]);
    const session = await sessionByHash(env, hash);
    invariant(session, 'access_denied', 'Account unavailable.', 403);
    return { session, cookies: [cookie(SESSION_COOKIE, token, 2592000), cookie(CSRF_COOKIE, csrf, 2592000, false)] };
}
