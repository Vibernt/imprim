#!/usr/bin/env node
/** Offline import of existing users, so they keep their ids as `sub` when an app moves to Imprim. Input JSON shape:
 * {"principals":[{"id":"principal-id","email":"member@example.com","created_at":1700000000000}],
 *  "principal_identities":[{"provider":"github","subject":"123","principal_id":"principal-id",
 *    "login":"octocat","created_at":1700000000000}]}
 * A principal with email "deleted:<id>", status "deleted", or a non-null deleted_at is imported deleted.
 * Optional status "blocked" and boolean email_verified are honored. Principals without that flag are taken as
 * created after a verified sign-in, so active imports use email_verified=1. Deleted imports use 0.
 * Usage: node scripts/import-users.mjs export.json [realm] > import.sql   (realm defaults to 'default')
 * No network, subprocess, credentials, or remote writes. SQL is printed only after the entire input validates.
 * Re-running preserves ids and does not reactivate a blocked/deleted destination user or relink a provider id.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { normalizeEmail } from '../apps/server/src/services/admission.mjs';
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
function assert(value, message) { if (!value) throw new Error(message); }
function timestamp(value) { assert(Number.isSafeInteger(value) && value >= 0, 'created_at must be non-negative integer milliseconds'); return value; }
function identifier(value) { assert(typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value), 'Invalid principal id'); return value; }
export function importSql(data, realm = 'default') {
    assert(/^[a-z0-9-]{1,40}$/.test(realm), 'Invalid realm id');
    assert(data && Array.isArray(data.principals) && Array.isArray(data.principal_identities), 'Expected principals and principal_identities arrays');
    const ids = new Set(), emails = new Set(), identities = new Set();
    const users = data.principals.map(p => {
        const id = identifier(p.id);
        assert(!ids.has(id), 'Duplicate principal id'); ids.add(id);
        const deleted = p.status === 'deleted' || p.deleted_at != null || String(p.email).startsWith('deleted:');
        assert(p.status === undefined || ['active', 'blocked', 'deleted'].includes(p.status), 'Invalid principal status');
        const email = deleted ? `deleted:${id}` : normalizeEmail(p.email);
        assert(!emails.has(email.toLowerCase()), 'Duplicate normalized email'); emails.add(email.toLowerCase());
        assert(p.email_verified === undefined || typeof p.email_verified === 'boolean' || [0,1].includes(p.email_verified), 'Invalid email_verified');
        return { id, email, verified: deleted ? 0 : Number(p.email_verified ?? true), status: deleted ? 'deleted' : p.status || 'active', created: timestamp(p.created_at) };
    });
    const links = data.principal_identities.map(i => {
        assert(i.provider === 'github' && typeof i.subject === 'string' && /^[1-9][0-9]*$/.test(i.subject), 'Expected GitHub numeric subject string');
        assert(ids.has(i.principal_id), 'Identity references an unknown principal');
        const key = `${i.provider}:${i.subject}`;
        assert(!identities.has(key), 'Duplicate provider identity'); identities.add(key);
        assert(i.login == null || (typeof i.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(i.login)), 'Invalid GitHub login');
        return { ...i, created_at: timestamp(i.created_at) };
    });
    const output = ['-- Offline user import. Review before applying; ids are preserved as sub.', '-- No explicit BEGIN: D1 owns transaction boundaries. Back up before applying.'];
    for (const u of users) output.push(`INSERT INTO users(id,realm_id,email,email_verified,status,created) VALUES(${[u.id,realm,u.email,u.verified,u.status,u.created].map(sql).join(',')})
ON CONFLICT(id) DO UPDATE SET
 email=CASE WHEN users.status='deleted' THEN users.email ELSE excluded.email END,
 email_verified=CASE WHEN users.status='deleted' THEN 0 ELSE excluded.email_verified END,
 status=CASE WHEN users.status='deleted' OR excluded.status='deleted' THEN 'deleted' WHEN users.status='blocked' THEN 'blocked' ELSE excluded.status END;`);
    for (const i of links) output.push(`INSERT INTO user_identities(realm_id,provider,provider_id,user_id,login,created) VALUES(${[realm,i.provider,i.subject,i.principal_id,i.login ?? null,i.created_at].map(sql).join(',')})
ON CONFLICT(realm_id,provider,provider_id) DO UPDATE SET
 user_id=CASE WHEN user_identities.user_id=excluded.user_id THEN user_identities.user_id ELSE NULL END,
 login=excluded.login;`);
    return output.join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        assert(process.argv.length === 3 || process.argv.length === 4, 'Usage: node scripts/import-users.mjs export.json [realm] > import.sql');
        const output = importSql(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]);
        process.stdout.write(output);
        process.stderr.write('Generated SQL only; no network calls made. Review/backup first, then an operator may run:\nwrangler d1 execute vibernt-identity --remote --config apps/server/wrangler.jsonc --file import.sql\n');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
