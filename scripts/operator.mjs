#!/usr/bin/env node
// Generate reviewable D1 SQL. This command never opens a database connection.
import { checkClientId } from '../apps/server/src/admin/client-basics.mjs';
import { normalizeEmail } from '../apps/server/src/services/admission.mjs';
import { operatorAudit, platformAppUserGuard, quote, realmIdShape, requireChange } from './operator-sql.mjs';

const usage = `Usage:
  node scripts/operator.mjs invite <realm> <client> <email>
  node scripts/operator.mjs uninvite <realm> <client> <email>
  node scripts/operator.mjs admins add <realm> <email> <realm|platform> [--allow-app-user]
  node scripts/operator.mjs admins remove <realm> <email>
  node scripts/operator.mjs client signup-policy <realm> <client> <open|invited> --version <n>`;

function need(condition) {
    if (!condition) throw new Error(usage);
}

function realmValue(id) {
    need(realmIdShape(id));
    return quote(id);
}

function clientValue(id) {
    checkClientId(id);
    return quote(id);
}

function invitation(command, args) {
    need(args.length === 3);
    const realm = realmValue(args[0]), client = clientValue(args[1]), email = quote(normalizeEmail(args[2]));
    const registeredClient = `SELECT id FROM clients WHERE id=${client} AND realm_id=${realm}`;
    const add = command === 'invite';
    return [add
        ? `INSERT INTO invitations(client_id,email,expires_at)
SELECT id,${email},(unixepoch()+30*86400)*1000 FROM clients WHERE id=${client} AND realm_id=${realm}
ON CONFLICT(client_id,email) DO UPDATE SET expires_at=excluded.expires_at;`
        : `DELETE FROM invitations WHERE email=${email} AND client_id IN (${registeredClient});`,
    requireChange, operatorAudit(realm, add ? 'invitation_registered' : 'invitation_revoked', null)];
}

function roster([action, realmId, address, role, flag, ...extra]) {
    const add = action === 'add';
    need(!extra.length && (add ? ['realm', 'platform'].includes(role) &&
        (flag === undefined || (role === 'platform' && flag === '--allow-app-user')) :
        action === 'remove' && role === undefined && flag === undefined));
    const realm = realmValue(realmId), email = quote(normalizeEmail(address));
    const guard = role === 'platform' ? platformAppUserGuard(realm, email, flag === '--allow-app-user') : [];
    return [...guard, add
        ? `INSERT INTO admins(realm_id,email,role,created,created_by)
SELECT id,${email},${quote(role)},unixepoch()*1000,'operator-cli' FROM realms WHERE id=${realm}
ON CONFLICT(realm_id,email) DO UPDATE SET role=excluded.role;`
        : `DELETE FROM admins WHERE realm_id=${realm} AND email=${email};`,
    requireChange, operatorAudit(realm, add ? 'admin_roster_set' : 'admin_roster_remove', realm, { role: role ?? null })];
}

function signupPolicy([action, realmId, clientId, policy, flag, reviewedVersion, ...extra]) {
    const version = Number(reviewedVersion);
    need(!extra.length && action === 'signup-policy' && ['open', 'invited'].includes(policy) &&
        flag === '--version' && /^[0-9]+$/.test(reviewedVersion) && Number.isSafeInteger(version));
    const realm = realmValue(realmId), client = clientValue(clientId);
    return [`UPDATE clients SET signup_policy=${quote(policy)},version=version+1
WHERE id=${client} AND realm_id=${realm} AND version=${version};`,
    requireChange, operatorAudit(realm, 'admin_client_update', client, { fields: ['signup_policy'] })];
}

try {
    const [command, ...args] = process.argv.slice(2);
    let lines;
    switch (command) {
        case 'invite': case 'uninvite': lines = invitation(command, args); break;
        case 'admins': lines = roster(args); break;
        case 'client': lines = signupPolicy(args); break;
        default: throw new Error(usage);
    }
    console.log(['-- Review before applying with wrangler d1 execute <db> --remote --file out.sql.',
        '-- Apply as one transaction. D1 owns transaction boundaries.', ...lines].join('\n'));
} catch {
    console.error(usage);
    process.exitCode = 2;
}
