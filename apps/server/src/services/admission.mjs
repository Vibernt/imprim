// Admission: who may sign in to which app. Workspace permissions and rosters stay in apps.
import { invariant } from '../lib/errors.mjs';
export function normalizeEmail(value) {
    invariant(typeof value === 'string' && value.length <= 254 && /^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(value), 'invalid_request', 'A valid email is required.');
    return value.toLowerCase();
}
import { realmId } from '../realms/realm.mjs';
// Admins are a D1 roster per realm (scripts/realm.mjs), never a committed variable. Returns 'platform', 'realm' or null.
export async function adminRole(env, email) {
    if (typeof email !== 'string') return null;
    const row = await env.DB.prepare('SELECT role FROM admins WHERE realm_id=? AND email=?').bind(realmId(env), email.toLowerCase()).first();
    return row?.role ?? null;
}
export const isAdmin = async (env, email) => Boolean(await adminRole(env, email));
const domainOf = email => email.split('@')[1];
// How strongly the current sign-in proves control of the mailbox (S4):
//   email  - a magic link reached the mailbox;
//   google - Google is authoritative only for gmail.com or when its signed `hd` equals the email's domain;
//   other  - a provider's "verified" flag, which can be years old (GitHub never re-verifies).
export function mailboxProof(method, email, hd = null) {
    if (method === 'email') return 'mailbox';
    if (method === 'google' && (domainOf(email) === 'gmail.com' || (hd && domainOf(email) === hd))) return 'mailbox';
    return 'provider';
}
// Client policy alone: open signup, an invitation for this exact address, or an allowed domain proven by the mailbox.
// proof 'claim' (an email no one vouched for) admits only by open signup or an earlier admission, never by an
// invitation or domain addressed to that mailbox.
async function policyAdmits(env, client, email, proof) {
    if (client.signup_policy === 'open') return true;
    if (proof === 'claim') return false;
    if (proof === 'mailbox' && JSON.parse(client.allowed_domains).includes(domainOf(email))) return true;
    return Boolean(await env.DB.prepare('SELECT 1 FROM invitations WHERE client_id=? AND email=? AND expires_at>?')
        .bind(client.id, email, Date.now()).first());
}
// Admission is per (user, app) (S3). An existing account is admitted to an app it already reached, or by that app's
// own policy. It is never admitted because it exists.
export async function admitted(env, client, email, proof = 'mailbox') {
    const user = await env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realmId(env), email).first();
    if (user && (user.status !== 'active' || user.merged_into)) return false;
    if (!client) return isAdmin(env, email); // Bootstrap operator login, without registering an RP.
    if (user && await env.DB.prepare('SELECT 1 FROM client_admissions WHERE user_id=? AND client_id=?').bind(user.id, client.id).first()) return true;
    return policyAdmits(env, client, email, proof);
}
// Called when a session is about to reach an app: record the admission, or refuse.
export async function admitSession(env, client, session) {
    if (await env.DB.prepare('SELECT 1 FROM client_admissions WHERE user_id=? AND client_id=?').bind(session.user_id, client.id).first()) return;
    const proof = mailboxProof(session.method, session.email, session.google_hd);
    invariant(await policyAdmits(env, client, session.email, proof), 'access_denied', 'This app has not admitted your account.', 403);
    await env.DB.prepare('INSERT OR IGNORE INTO client_admissions(user_id,client_id,created) VALUES(?,?,?)').bind(session.user_id, client.id, Date.now()).run();
}
// SQL fence for credential issuance: `user` is the SQL expression naming the user id.
export const admissionGuard = (user, clientId) => ({ sql: `EXISTS(SELECT 1 FROM client_admissions WHERE user_id=${user} AND client_id=?)`, args: [clientId] });
// `verified` is true only with mailbox proof. An account a provider created on its say-so stays unverified until an
// email link reaches the mailbox (claimMailbox).
export async function ensureUser(env, email, verified = true) {
    const realm = realmId(env);
    await env.DB.prepare('INSERT INTO users(id,realm_id,email,email_verified,status,created) VALUES(?,?,?,?,\'active\',?) ON CONFLICT(realm_id,email) DO NOTHING')
        .bind(crypto.randomUUID(), realm, email, verified ? 1 : 0, Date.now()).run();
    if (verified) await env.DB.prepare("UPDATE users SET email_verified=1 WHERE realm_id=? AND email=? AND status='active' AND merged_into IS NULL").bind(realm, email).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realm, email).first();
    invariant(user.status === 'active' && !user.merged_into, 'access_denied', 'Account unavailable.', 403);
    return user;
}
