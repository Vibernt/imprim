import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { world } from './support/world.mjs';

const script = fileURLToPath(new URL('../scripts/import-workspaces.mjs', import.meta.url));
const team = (overrides = {}) => ({ id: 'notes-legacy', name: "O'Brien's team", kind: 'team',
    members: [{ sub: "owner's-id", role: 'owner' }, { sub: 'member-2', role: 'viewer' }],
    invitations: [{ email: "BILL.O'BRIEN@Example.COM", role: 'viewer' }], ...overrides });
const personal = (sub, overrides = {}) => ({ name: 'Personal', kind: 'personal', members: [{ sub, role: 'owner' }], invitations: [], ...overrides });
const fixture = () => ({ products: {
    notes: [team(), personal('personal-1', { id: 'existing personal/id' })],
    tasks: [team({ id: undefined, name: 'Platform', members: [{ sub: "owner's-id", role: 'owner' }, { sub: 'member-2', role: 'admin' }, { sub: 'member-3', role: 'member' }],
        invitations: [{ email: "bill.o'brien@example.com", role: 'member' }, { email: 'new@example.com', role: 'admin' }] }),
    team({ id: 'just-tasks', name: "O'Brien's team", members: [{ sub: 'member-2', role: 'owner' }], invitations: [] })],
} });
function cli(t) {
    const directory = mkdtempSync(join(tmpdir(), 'imprim-workspace-import-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const inputFile = join(directory, 'input.json'), pairFile = join(directory, 'pairs.json');
    return (data, { realm = 'default', pairs, preview = false, args = [] } = {}) => {
        writeFileSync(inputFile, JSON.stringify(data));
        if (pairs !== undefined) writeFileSync(pairFile, JSON.stringify(pairs));
        return spawnSync(process.execPath, [script, inputFile, '--realm', realm, ...args,
            ...(pairs === undefined ? [] : ['--pairs', pairFile]), ...(preview ? ['--dry-run'] : [])], { encoding: 'utf8' });
    };
}
const success = result => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
};
const refused = (result, message) => {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
};
function apply(db, sql) {
    db.exec('BEGIN');
    try { db.exec(sql); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
}
const paired = [['notes:notes-legacy', 'tasks:Platform']];

test('dry-run identifies shared owners and previews only explicitly confirmed merges', t => {
    const run = cli(t), input = fixture();
    const preview = JSON.parse(success(run(input, { preview: true })));
    assert.deepEqual(preview.proposed_pairs, paired, 'a shared member and matching names alone do not make a pair');
    assert.deepEqual(preview.workspaces.map(row => [row.id, row.sources, row.products]), [
        ['notes-legacy', ['notes:notes-legacy'], ['notes']],
        [null, ['notes:existing personal/id'], ['notes']],
        [null, ['tasks:Platform'], ['tasks']],
        ['just-tasks', ['tasks:just-tasks'], ['tasks']],
    ]);
    const merged = JSON.parse(success(run(input, { preview: true, pairs: paired })));
    assert.deepEqual(merged.workspaces[0], { id: 'notes-legacy', name: "O'Brien's team", kind: 'team', sources: paired[0],
        products: ['notes', 'tasks'], member_count: 3, invitation_count: 2 });
    assert.equal(merged.workspaces.length, 3);
    const reverse = JSON.parse(success(run(input, { preview: true, pairs: [[...paired[0]].reverse()] })));
    assert.equal(reverse.workspaces.find(row => row.products.length === 2).name, 'Platform');
    assert.equal(reverse.workspaces.find(row => row.products.length === 2).id, null, 'only the first source can supply its id');
});

test('SQL preserves ids and subjects, merges stronger roles, and inserts invitations for 30 days without events', async t => {
    const w = await world(t), run = cli(t), db = w.env.DB.db;
    const user = db.prepare('INSERT INTO users (id, realm_id, email, created) VALUES (?, ?, ?, ?)');
    for (const [index, sub] of ["owner's-id", 'member-2', 'member-3', 'personal-1'].entries())
        user.run(sub, 'default', `test-${index}@example.com`, 0);
    const sql = success(run(fixture(), { pairs: paired }));
    apply(db, sql);
    const chosen = db.prepare('SELECT id, realm_id, name, kind, status, personal_owner, version FROM workspaces WHERE id=?').get('notes-legacy');
    assert.deepEqual({ ...chosen }, { id: 'notes-legacy', realm_id: 'default', name: "O'Brien's team", kind: 'team', status: 'active', personal_owner: null, version: 1 });
    const solo = db.prepare('SELECT id, personal_owner, version FROM workspaces WHERE kind=?').get('personal');
    assert.match(solo.id, /^ws_[a-f0-9]{32}$/);
    assert.equal(solo.personal_owner, 'personal-1');
    assert.equal(solo.version, 1);
    const products = db.prepare('SELECT product FROM workspace_products WHERE workspace_id=? ORDER BY product');
    assert.deepEqual(products.all(chosen.id).map(row => row.product), ['notes', 'tasks']);
    assert.deepEqual(products.all(solo.id).map(row => row.product), ['notes']);
    assert.deepEqual(products.all('just-tasks').map(row => row.product), ['tasks']);
    const members = db.prepare('SELECT user_id, role FROM workspace_members WHERE workspace_id=? ORDER BY user_id');
    assert.deepEqual(members.all(chosen.id).map(row => [row.user_id, row.role]), [
        ['member-2', 'admin'], ['member-3', 'member'], ["owner's-id", 'owner'],
    ]);
    assert.deepEqual(members.all(solo.id).map(row => [row.user_id, row.role]), [['personal-1', 'owner']]);
    const invitations = db.prepare('SELECT * FROM workspace_invitations ORDER BY email').all();
    assert.deepEqual(invitations.map(row => [row.email, row.role]), [["bill.o'brien@example.com", 'member'], ['new@example.com', 'admin']]);
    for (const row of invitations) {
        assert.equal(row.workspace_id, chosen.id);
        assert.equal(row.expires_at - row.created, 30 * 86_400_000);
        assert.deepEqual([row.accepted_at, row.revoked_at, row.invited_by, row.via_client], [null, null, null, null]);
    }
    assert.equal(db.prepare('SELECT count(*) n FROM workspace_event_outbox').get().n, 0);
    assert.throws(() => apply(db, sql), /UNIQUE/);
    assert.equal(db.prepare('SELECT count(*) n FROM workspaces').get().n, 3);
});

test('invalid workspaces and pairs are refused before writing any SQL', t => {
    const run = cli(t);
    const invalid = [
        [null, /products map/],
        [{ products: { Notes: [] } }, /Invalid product/],
        [{ products: { notes: {} } }, /must be an array/],
        [{ products: { notes: [team({ name: 'x'.repeat(121) })] } }, /1 to 120 characters/],
        [{ products: { notes: [team({ kind: 'group' })] } }, /kind must be/],
        [{ products: { notes: [team({ id: 1 })] } }, /id must be non-empty text/],
        [{ products: { notes: [team(), team()] } }, /duplicate workspace id/],
        [{ products: { notes: [team(), team({ id: undefined, name: 'notes-legacy' })] } }, /duplicate workspace reference/],
        [{ products: { notes: [team({ members: [{ sub: 'someone', role: 'viewer' }] })] } }, /at least one owner/],
        [{ products: { notes: [team({ members: [{ sub: 'someone', role: 'root' }] })] } }, /valid role/],
        [{ products: { notes: [team({ members: [{ sub: 12, role: 'owner' }] })] } }, /valid principal sub/],
        [{ products: { notes: [team({ members: [{ sub: 'same', role: 'owner' }, { sub: 'same', role: 'member' }] })] } }, /duplicate member sub/],
        [{ products: { notes: [team({ invitations: [{ email: 'bad.example', role: 'member' }] })] } }, /valid email/],
        [{ products: { notes: [team({ invitations: [{ email: 'ok@example.com', role: 'missing' }] })] } }, /valid role/],
        [{ products: { notes: [team({ invitations: [{ email: 'x@example.com', role: 'member' }, { email: 'X@example.com', role: 'viewer' }] })] } }, /duplicate normalized email/],
        [{ products: { notes: [team({ kind: 'personal', invitations: [] })] } }, /one member and no invitations/],
        [{ products: { notes: [personal('someone', { invitations: [{ email: 'x@example.com', role: 'viewer' }] })] } }, /one member and no invitations/],
    ];
    for (const [input, message] of invalid) refused(run(input), message);
    refused(run(fixture(), { realm: 'default; SELECT 1' }), /Invalid realm id/);
    refused(run(fixture(), { args: ['--realm', 'other'] }), /Usage/);
    refused(run(fixture(), { pairs: null }), /array of confirmed pairs/);
    refused(run(fixture(), { pairs: [['notes:notes-legacy']] }), /two workspace references/);
    refused(run(fixture(), { pairs: [['notes:notes-legacy', 'tasks:missing']] }), /unknown or already paired/);
    refused(run(fixture(), { pairs: [...paired, ...paired] }), /unknown or already paired/);
    refused(run(fixture(), { pairs: [['tasks:Platform', 'tasks:just-tasks']] }), /different products/);
    refused(run(fixture(), { pairs: [['notes:notes-legacy', 'tasks:just-tasks']] }), /share a kind and an owner/);
    const shared = { products: { notes: [personal("owner's-id")], tasks: [team()] } };
    refused(run(shared, { pairs: [['notes:Personal', 'tasks:notes-legacy']] }), /share a kind and an owner/);
    const twice = { products: { notes: [personal('same')], tasks: [personal('same')] } };
    refused(run(twice), /Only one personal workspace per owner/);
    const review = JSON.parse(success(run(twice, { preview: true })));
    assert.deepEqual(review.proposed_pairs, [['notes:Personal', 'tasks:Personal']]);
    assert.equal(JSON.parse(success(run(twice, { preview: true, pairs: review.proposed_pairs }))).workspaces.length, 1);
});

test('applying a file cannot attach a missing or foreign-realm subject', async t => {
    const w = await world(t), run = cli(t), db = w.env.DB.db;
    db.prepare('INSERT INTO realms (id, issuer, display_name, created) VALUES (?, ?, ?, ?)').run('foreign', 'https://foreign.example', 'Foreign', 0);
    db.prepare('INSERT INTO users (id, realm_id, email, created) VALUES (?, ?, ?, ?)').run('foreign-sub', 'foreign', 'owner@example.com', 0);
    for (const sub of ['foreign-sub', 'missing']) {
        const sql = success(run({ products: { notes: [team({ members: [{ sub, role: 'owner' }] })] } }));
        assert.throws(() => apply(db, sql), /NOT NULL constraint failed: workspace_members.user_id/);
        assert.equal(db.prepare('SELECT count(*) n FROM workspaces').get().n, 0);
    }
    apply(db, success(run({ products: { notes: [personal('foreign-sub')], tasks: [personal('foreign-sub')] } },
        { realm: 'foreign', pairs: [['notes:Personal', 'tasks:Personal']] })));
    const row = db.prepare('SELECT realm_id, personal_owner FROM workspaces').get();
    assert.deepEqual({ ...row }, { realm_id: 'foreign', personal_owner: 'foreign-sub' });
    assert.equal(db.prepare('SELECT count(*) n FROM workspace_members').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM workspace_products').get().n, 2);
});
