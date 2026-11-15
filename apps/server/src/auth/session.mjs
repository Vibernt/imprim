// Identity sessions: host-only cookies, 30 days, strict Origin for mutations.
import { randomToken, sha256, safeEqual } from '../lib/crypto.mjs';
import { isAdmin } from '../services/admission.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { notify } from '../services/notify.mjs';
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
    const session = await sessionByHash(env, await sha256(value));
    // Last seen, for the sessions list: at most one write per session every five minutes.
    if (session && (!session.last_seen || session.last_seen < Date.now() - 300000))
        await env.DB.prepare('UPDATE sessions SET last_seen=? WHERE hash=?').bind(Date.now(), session.hash).run();
    // The page shell shows who is signed in (pages/layout.mjs).
    if (session && env.SEEN) env.SEEN.email = session.email;
    return session;
}
export async function sessionByHash(env, hash) {
    // A session belongs to the realm of its user; another realm's host never accepts it.
    return env.DB.prepare(`SELECT s.*,u.email,u.email_verified,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id
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
    const where = env.REQUEST ?? { device: null, location: null };
    const insert = env.DB.prepare(`INSERT INTO sessions(hash,sid,user_id,csrf_hash,method,auth_time,expires_at,google_hd,admin_until,amr,device,location,last_seen)
        SELECT ?,?,id,?,?,?,?,?,?,?,?,?,? FROM users WHERE id=? AND realm_id=? AND status='active' AND merged_into IS NULL`)
        .bind(hash, sid, await sha256(csrf), method, Math.floor(now / 1000), now + 30 * 86400000, googleHd, admin ? now + 3600000 : null, JSON.stringify(amrFor(method)),
            where.device, where.location, now, user.id, realmId(env));
    await env.DB.batch([insert, ...(admin ? [env.DB.prepare(`INSERT INTO audit(event,actor,target,detail,created,realm_id)
        SELECT 'admin_sign_in',user_id,user_id,'{"method":"email"}',?,? FROM sessions WHERE hash=?`).bind(now, realmId(env), hash)] : [])]);
    const session = await sessionByHash(env, hash);
    invariant(session, 'access_denied', 'Account unavailable.', 403);
    await noticeNewDevice(env, session);
    return { session, cookies: [cookie(SESSION_COOKIE, token, 2592000), cookie(CSRF_COOKIE, csrf, 2592000, false)] };
}
// A sign-in from a device (browser, OS and country) this person has not used in 90 days sends a notice. The first
// sign-in ever sends none.
async function noticeNewDevice(env, session) {
    if (!env.REQUEST?.device) return;
    const deviceHash = await sha256(`${env.REQUEST.device}\n${(env.REQUEST.location || '').split(', ').at(-1)}`), now = Date.now();
    const known = await env.DB.prepare('SELECT device_hash,last_seen FROM seen_devices WHERE user_id=?').bind(session.user_id).all();
    const seen = known.results.find(row => row.device_hash === deviceHash && row.last_seen > now - 90 * 86400000);
    await env.DB.prepare('INSERT INTO seen_devices(user_id,device_hash,last_seen) VALUES(?,?,?) ON CONFLICT(user_id,device_hash) DO UPDATE SET last_seen=excluded.last_seen')
        .bind(session.user_id, deviceHash, now).run();
    if (!seen && known.results.length) notify(env, env.CTX, session.email, 'new sign-in',
        `Your account was signed in from ${env.REQUEST.device}${env.REQUEST.location ? ` in ${env.REQUEST.location}` : ''} on ${new Date(now).toUTCString()}.`);
}
