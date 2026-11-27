#!/usr/bin/env node
// Generates reviewable SQL for a realm and its first admins. It never connects to a database.
// Usage: node scripts/realm.mjs realm.json > realm.sql
//   { "id": "acme", "issuer": "https://id.example.com", "display_name": "Acme",
//     "config": { ... see docs/REALMS.md ... }, "admins": [{ "email": "ops@example.com", "role": "realm" }],
//     "update": false }
// With "update": true, an existing realm's issuer, name and config are replaced (the id is the key).
import { readFile } from 'node:fs/promises';
import { validateRealmConfig } from '../apps/server/src/realms/realm.mjs';
import { normalizeEmail } from '../apps/server/src/services/admission.mjs';
import { platformAppUserGuard, quote, realmIdShape } from './operator-sql.mjs';
const [file, flag, ...extra] = process.argv.slice(2);
if (!file || file.startsWith('--') || extra.length || (flag !== undefined && flag !== '--allow-app-user')) {
    console.error('Usage: node scripts/realm.mjs realm.json [--allow-app-user]');
    process.exit(2);
}
const input = JSON.parse(await readFile(file, 'utf8'));
const fail = message => { console.error(message); process.exit(1); };
if (!realmIdShape(input.id)) fail('id: 1-40 lowercase letters, digits or hyphens.');
let issuer;
try { issuer = new URL(input.issuer); } catch { fail('issuer must be an https origin.'); }
if (issuer.protocol !== 'https:' || issuer.origin !== input.issuer) fail('issuer must be a canonical https origin, without a path or trailing slash.');
if (typeof input.display_name !== 'string' || !input.display_name.trim() || input.display_name.length > 100) fail('display_name: 1-100 characters.');
const settings = input.config === undefined ? {} : input.config;
try { validateRealmConfig(settings); } catch (error) { fail(error.message); }
const admins = input.admins ?? [];
if (!Array.isArray(admins) || admins.some(admin => !['platform', 'realm'].includes(admin?.role)))
    fail('admins: a list of { email, role: "platform" | "realm" }.');
let emails;
try { emails = admins.map(admin => normalizeEmail(admin.email)); } catch { fail('admins: a valid email is required for each entry.'); }
const now = Date.now(), config = JSON.stringify(settings);
const lines = [`-- Realm ${input.id} (${input.issuer}). Review before applying: wrangler d1 execute <db> --remote --file realm.sql`];
lines.push(input.update
    ? `UPDATE realms SET issuer=${quote(input.issuer)}, display_name=${quote(input.display_name)}, config=${quote(config)}, version=version+1 WHERE id=${quote(input.id)};`
    : `INSERT INTO realms(id, issuer, display_name, config, created) VALUES(${quote(input.id)}, ${quote(input.issuer)}, ${quote(input.display_name)}, ${quote(config)}, ${now});`);
for (const [index, admin] of admins.entries()) {
    const realm = quote(input.id), email = quote(emails[index]);
    if (admin.role === 'platform') lines.push(...platformAppUserGuard(realm, email, flag === '--allow-app-user'));
    lines.push(`INSERT INTO admins(realm_id, email, role, created, created_by) VALUES(${realm}, ${email}, ${quote(admin.role)}, ${now}, 'scripts/realm.mjs') ON CONFLICT(realm_id, email) DO UPDATE SET role=excluded.role;`);
}
console.log(lines.join('\n'));
