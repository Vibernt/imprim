#!/usr/bin/env node
// Offline import. Dry-run reports source references ("product:id", or "product:name" when no id was supplied).
// The first reference in a confirmed pair supplies the name and any reusable id.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { validProduct } from '../apps/server/src/admin/clients.mjs';
import { invariant } from '../apps/server/src/lib/errors.mjs';
import { normalizeEmail } from '../apps/server/src/services/admission.mjs';

const USAGE = 'Usage: node scripts/import-workspaces.mjs input.json --realm default [--pairs pairs.json] [--dry-run]';
const ROLES = ['viewer', 'member', 'admin', 'owner'];
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = 86_400_000;
const requireInput = (ok, message) => invariant(ok, 'invalid_request', message, 400);
const cleanText = value => typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const objectWith = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => fields.includes(key));

function roster(entries, field, key, parse, where) {
    requireInput(Array.isArray(entries), `${where} must be an array.`);
    const roles = new Map();
    for (const [index, entry] of entries.entries()) {
        const location = `${where}[${index}]`;
        requireInput(objectWith(entry, [field, 'role']) && ROLES.includes(entry.role), `${location} must have ${field} and a valid role.`);
        const value = parse(entry[field], location);
        requireInput(!roles.has(value), `${location} has a duplicate ${key}.`);
        roles.set(value, entry.role);
    }
    return roles;
}

function readWorkspaces(data) {
    requireInput(objectWith(data, ['products']) && data.products && typeof data.products === 'object' && !Array.isArray(data.products),
        'Expected an object containing a products map.');
    const ids = new Set(), refs = new Set(), workspaces = [];
    for (const [product, entries] of Object.entries(data.products)) {
        requireInput(validProduct(product), 'Invalid product. Use 2 to 40 lowercase letters, digits or dashes, starting with a letter.');
        requireInput(Array.isArray(entries), `Workspaces for ${product} must be an array.`);
        for (const [index, item] of entries.entries()) {
            const where = `${product}[${index}]`;
            requireInput(objectWith(item, ['id', 'name', 'kind', 'members', 'invitations']), `${where} has an invalid workspace shape.`);
            const { id, name, kind } = item;
            requireInput(cleanText(name) && [...name].length <= 120, `${where} needs a name of 1 to 120 characters.`);
            requireInput(['team', 'personal'].includes(kind), `${where} kind must be team or personal.`);
            if (id !== undefined) {
                requireInput(cleanText(id), `${where} id must be non-empty text.`);
                requireInput(!ids.has(id), `${where} has a duplicate workspace id.`);
                ids.add(id);
            }
            const ref = `${product}:${id ?? name}`;
            requireInput(!refs.has(ref), `${where} has a duplicate workspace reference. Supply a distinct id.`);
            refs.add(ref);
            const members = roster(item.members, 'sub', 'member sub', (sub, location) => {
                requireInput(cleanText(sub) && sub.length <= 200, `${location} needs a valid principal sub.`);
                return sub;
            }, `${where}.members`);
            const owners = [...members].filter(([, role]) => role === 'owner').map(([sub]) => sub);
            requireInput(owners.length > 0, `${where} needs at least one owner.`);
            const invitations = roster(item.invitations, 'email', 'normalized email', (email, location) => {
                try { return normalizeEmail(email); }
                catch { requireInput(false, `${location} needs a valid email.`); }
            }, `${where}.invitations`);
            requireInput(kind !== 'personal' || (members.size === 1 && invitations.size === 0),
                `${where} personal workspaces must have one member and no invitations.`);
            workspaces.push({ id: typeof id === 'string' && WORKSPACE_ID.test(id) ? id : null,
                refs: [ref], name, kind, products: [product], members, invitations, owners });
        }
    }
    return workspaces;
}

const sharesOwner = (a, b) => a.owners.some(sub => b.members.get(sub) === 'owner');
function proposedPairs(workspaces) {
    const pairs = [];
    for (const [index, first] of workspaces.entries())
        for (let next = index + 1; next < workspaces.length; next++) {
            const second = workspaces[next];
            if (first.products[0] !== second.products[0] && sharesOwner(first, second))
                pairs.push([first.refs[0], second.refs[0]]);
        }
    return pairs;
}
function higherRoles(first, second) {
    const result = new Map(first);
    for (const [value, role] of second)
        if (ROLES.indexOf(role) > ROLES.indexOf(result.get(value))) result.set(value, role);
    return result;
}
function confirmPairs(workspaces, pairs) {
    requireInput(Array.isArray(pairs), 'Expected an array of confirmed pairs.');
    const remaining = new Map(workspaces.map(workspace => [workspace.refs[0], workspace]));
    const merged = new Map();
    for (const [index, pair] of pairs.entries()) {
        const where = `Pair ${index + 1}`;
        requireInput(Array.isArray(pair) && pair.length === 2 && pair.every(ref => typeof ref === 'string'), `${where} must contain two workspace references.`);
        const [first, second] = pair.map(ref => remaining.get(ref));
        requireInput(first && second, `${where} refers to an unknown or already paired workspace.`);
        requireInput(first.products[0] !== second.products[0], `${where} must use two different products.`);
        requireInput(first.kind === second.kind && sharesOwner(first, second), `${where} must share a kind and an owner.`);
        for (const ref of pair) remaining.delete(ref);
        merged.set(pair[0], { ...first, refs: pair, products: [...first.products, ...second.products],
            members: higherRoles(first.members, second.members), invitations: higherRoles(first.invitations, second.invitations) });
    }
    const result = workspaces.map(({ refs: [ref] }) => merged.get(ref) ?? remaining.get(ref)).filter(Boolean);
    const personalOwners = new Set();
    for (const { kind, owners } of result) if (kind === 'personal') {
        requireInput(!personalOwners.has(owners[0]), 'Only one personal workspace per owner can be imported. Confirm a pair or correct the input.');
        personalOwners.add(owners[0]);
    }
    return result;
}

// The offline file needs self-contained SQL literals. Escape text once and use fixed table and column names.
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
const values = (...args) => args.map(sql).join(',');
function importSql(workspaces, realm) {
    const lines = ['-- Offline workspace import. Review before applying. Import the realm and its users first.',
        '-- Inserts only. Apply as one transaction. No explicit BEGIN: D1 owns transaction boundaries.'];
    const now = Date.now(), ids = new Set(workspaces.map(workspace => workspace.id));
    for (const { id: preservedId, name, kind, products, members, invitations, owners } of workspaces) {
        const id = preservedId ?? 'ws_' + randomUUID().replaceAll('-', '');
        requireInput(preservedId || !ids.has(id), 'Generated a duplicate workspace id. Run the import again.');
        ids.add(id);
        const owner = kind === 'personal' ? owners[0] : null;
        lines.push(`INSERT INTO workspaces(id,realm_id,name,kind,personal_owner,version,created) VALUES(${values(id, realm, name, kind, owner, 1, now)});`);
        // A global foreign key alone would accept a sub from a different realm. A missing user yields NULL and aborts.
        for (const [sub, role] of members)
            lines.push(`INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES(${sql(id)},(SELECT id FROM users WHERE realm_id=${sql(realm)} AND id=${sql(sub)}),${values(role, now, now)});`);
        for (const product of products)
            lines.push(`INSERT INTO workspace_products(workspace_id,product,created) VALUES(${values(id, product, now)});`);
        for (const [email, role] of invitations)
            lines.push(`INSERT INTO workspace_invitations(id,workspace_id,email,role,created,expires_at) VALUES(${values('wi_' + randomUUID().replaceAll('-', ''), id, email, role, now, now + 30 * DAY)});`);
    }
    return lines.join('\n') + '\n';
}
function dryRun(source, workspaces) {
    return JSON.stringify({
        workspaces: workspaces.map(({ id, name, kind, refs, products, members, invitations }) =>
            ({ id, name, kind, sources: refs, products, member_count: members.size, invitation_count: invitations.size })),
        proposed_pairs: proposedPairs(source),
    }, null, 2) + '\n';
}

function readJson(file, label) {
    const contents = readFileSync(file, 'utf8');
    try { return JSON.parse(contents); }
    catch { requireInput(false, `${label} must contain valid JSON.`); }
}

try {
    const { positionals, values: options } = parseArgs({ allowPositionals: true,
        options: { realm: { type: 'string', multiple: true }, pairs: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean', multiple: true } } });
    requireInput(positionals.length === 1 && options.realm?.length === 1 && (options.pairs?.length ?? 0) <= 1
        && (options['dry-run']?.length ?? 0) <= 1, USAGE);
    const [realm] = options.realm;
    requireInput(/^[a-z0-9-]{1,40}$/.test(realm), 'Invalid realm id.');
    const source = readWorkspaces(readJson(positionals[0], 'The workspace input'));
    const pairs = options.pairs ? readJson(options.pairs[0], 'The pairs file') : [];
    const preview = Boolean(options['dry-run']);
    // An initial preview must be able to show the pairs that resolve duplicate personal ownership.
    const workspaces = preview && !options.pairs ? source : confirmPairs(source, pairs);
    process.stdout.write(preview ? dryRun(source, workspaces) : importSql(workspaces, realm));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
