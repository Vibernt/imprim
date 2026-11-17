// Admission: who may sign in to which app. Apps still check permissions.
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { invitationStatements, reachesProductSql, sharedClient, usesSharedWorkspaces, workspaceAdmits, workspaceClientSql } from '../workspaces/access.mjs';
export function normalizeEmail(value) {
    invariant(typeof value === 'string' && value.length <= 254 && /^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(value), 'invalid_request', 'A valid email is required.');
    return value.toLowerCase();
}
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
const appAdmission = (env, client, userId) => env.DB.prepare("SELECT 1 FROM client_admissions WHERE user_id=? AND client_id=? AND source='app'")
    .bind(userId, client.id).first();
// Only participating apps accept workspace access. A cached workspace admission is not proof of current membership.
export async function admitted(env, client, email, proof = 'mailbox') {
    const user = await env.DB.prepare('SELECT * FROM users WHERE realm_id=? AND email=?').bind(realmId(env), email).first();
    if (user && (user.status !== 'active' || user.merged_into)) return false;
    if (!client) return isAdmin(env, email); // Bootstrap operator login, without registering an RP.
    if (user && await appAdmission(env, client, user.id)) return true;
    if (await policyAdmits(env, client, email, proof)) return true;
    return sharedClient(client) && workspaceAdmits(env, client, user?.id ?? null, email, proof);
}
// Called when a session is about to reach an app: record the admission, or refuse.
export async function admitSession(env, client, session) {
    const shared = await usesSharedWorkspaces(env, client);
    const proof = shared ? sharedSessionProof(session) : mailboxProof(session.method, session.email, session.google_hd);
    invariant(await writeAdmission(env, client, session, proof, shared), 'access_denied', 'This app has not admitted your account.', 403);
}
// The provider has the proof from this sign-in. Its registry method alone cannot recover that proof later.
export async function recordAdmission(env, client, user, email, proof) {
    const shared = await usesSharedWorkspaces(env, client);
    invariant(await writeAdmission(env, client, { user_id: user.id, email }, proof, shared), 'access_denied', 'Account unavailable.', 403);
}
function sharedSessionProof(session) {
    // Built-in sign-in methods never issue a session on an unverified provider claim.
    return ['email', 'password', 'passkey', 'github', 'google'].includes(session.method)
        ? mailboxProof(session.method, session.email, session.google_hd) : 'claim';
}
const liveAdmission = `a.source='app' OR (${workspaceClientSql('c')}
    AND ${reachesProductSql('c.realm_id', 'c.product', 'a.user_id')})`;
const currentAdmission = (env, client, userId) => env.DB.prepare(`SELECT (${liveAdmission}) AS allowed
    FROM client_admissions a JOIN clients c ON c.id=a.client_id WHERE a.user_id=? AND a.client_id=?`)
    .bind(userId, client.id).first();

async function writeAdmission(env, client, subject, proof, shared) {
    const existing = await currentAdmission(env, client, subject.user_id);
    // The source is fixed when the admission is first recorded. Workspace access must still be live.
    if (existing) return existing.allowed === 1;
    if (shared) return writeSharedAdmission(env, client, subject, proof);
    if (!await policyAdmits(env, client, subject.email, proof)) return false;
    const result = await env.DB.prepare(`INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,?,?)
        ON CONFLICT(user_id,client_id) DO NOTHING`).bind(subject.user_id, client.id, Date.now()).run();
    return result.meta.changes === 1 || (await currentAdmission(env, client, subject.user_id))?.allowed === 1;
}

async function writeSharedAdmission(env, client, subject, proof) {
    const invitations = await invitationStatements(env, client, subject, proof), realm = realmId(env);
    const now = Date.now(), guard = admissionGuard('u.id', client.id);
    // Recheck both paths at the write. An app policy admission outranks workspace access.
    const record = env.DB.prepare(`WITH eligible AS (
        SELECT c.id AS client_id,u.id AS user_id,
            (c.signup_policy='open' OR (?='mailbox' AND EXISTS(SELECT 1 FROM json_each(c.allowed_domains) d WHERE d.value=?))
             OR (?<>'claim' AND EXISTS(SELECT 1 FROM invitations i WHERE i.client_id=c.id AND i.email=u.email AND i.expires_at>?))) AS app_access,
            (${workspaceClientSql('c')} AND ${reachesProductSql('c.realm_id', 'c.product', 'u.id')}) AS workspace_access
        FROM clients c JOIN users u ON u.realm_id=c.realm_id
        WHERE c.id=? AND c.realm_id=? AND u.id=? AND u.email=? AND u.status='active' AND u.merged_into IS NULL
        )
        INSERT INTO client_admissions(user_id,client_id,created,source)
        SELECT user_id,client_id,?,CASE WHEN app_access THEN 'app' ELSE 'workspace' END
        FROM eligible WHERE app_access OR workspace_access
        ON CONFLICT(user_id,client_id) DO NOTHING`)
        .bind(proof, domainOf(subject.email), proof, now, client.id, realm, subject.user_id, subject.email, now);
    const verify = env.DB.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.realm_id=? AND u.email=?
        AND u.status='active' AND u.merged_into IS NULL AND ${guard.sql}`)
        .bind(subject.user_id, realm, subject.email, ...guard.args);
    const result = await env.DB.batch([...invitations, record, verify]).catch(error => {
        invariant(!String(error.message).includes('admin_assertions'), 'conflict', 'A workspace invitation changed. Sign in again.', 409);
        throw error;
    });
    return result.at(-1).results.length === 1;
}
// SQL fence for credential issuance: `user` is the SQL expression naming the user id.
export const admissionGuard = (user, clientId) => ({
    sql: `EXISTS(SELECT 1 FROM client_admissions a JOIN clients c ON c.id=a.client_id
        WHERE a.user_id=${user} AND a.client_id=? AND (${liveAdmission}))`,
    args: [clientId]
});
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
