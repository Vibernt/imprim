import test from 'node:test';
import assert from 'node:assert/strict';
import { importSql } from '../scripts/import-users.mjs';
import { d1Database } from './support/sqlite.mjs';
const sample = () => ({ principals: [
    { id: "principal'1", email: 'Member@Example.com', created_at: 100 },
    { id: 'gone', email: 'deleted:gone', created_at: 90 }
], principal_identities: [{ provider: 'github', subject: '123', principal_id: "principal'1", login: 'member', created_at: 101 }] });
test('offline import preserves ids, quotes safely, normalizes email, marks deleted and is idempotent', t => {
    const d1 = d1Database(); t.after(() => d1.db.close());
    const sql = importSql(sample()); d1.db.exec(sql); d1.db.exec(sql);
    assert.equal(d1.db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
    assert.equal(d1.db.prepare("SELECT id FROM users WHERE email='member@example.com'").get().id, "principal'1");
    assert.equal(d1.db.prepare("SELECT status FROM users WHERE id='gone'").get().status, 'deleted');
    assert.equal(d1.db.prepare('SELECT count(*) AS n FROM user_identities').get().n, 1);
});
for (const status of ['blocked', 'deleted']) test(`reimport never reactivates ${status} destination`, t => {
    const d1 = d1Database(); t.after(() => d1.db.close()); d1.db.exec(importSql(sample()));
    d1.db.prepare('UPDATE users SET status=?').run(status);
    d1.db.exec(importSql(sample()));
    assert.equal(d1.db.prepare('SELECT status FROM users WHERE id=?').get("principal'1").status, status);
});
for (const kind of ['duplicate id', 'duplicate normalized email', 'orphan identity', 'invalid provider', 'invalid email', 'invalid time']) test(`import rejects ${kind} before SQL output`, () => {
    const data = sample();
    if (kind === 'duplicate id') data.principals.push({ ...data.principals[0] });
    if (kind === 'duplicate normalized email') data.principals.push({ ...data.principals[0], id: 'new', email: 'MEMBER@example.com' });
    if (kind === 'orphan identity') data.principal_identities[0].principal_id = 'unknown';
    if (kind === 'invalid provider') data.principal_identities[0].provider = 'gitlab';
    if (kind === 'invalid email') data.principals[0].email = "bad\r\nheader";
    if (kind === 'invalid time') data.principals[0].created_at = 'yesterday';
    assert.throws(() => importSql(data));
});
test('import refuses destination email collision or identity relinking', t => {
    const d1 = d1Database(); t.after(() => d1.db.close()); d1.db.exec(importSql(sample()));
    const data = sample(); data.principals[0].id = 'different'; data.principal_identities[0].principal_id = 'different';
    assert.throws(() => d1.db.exec(importSql(data)), /UNIQUE/);
    data.principals[0].email = 'different@example.com';
    assert.throws(() => d1.db.exec(importSql(data)), /NOT NULL/);
    assert.equal(d1.db.prepare('SELECT user_id FROM user_identities').get().user_id, "principal'1");
});

test('CLI emits only SQL on stdout, operator instructions on stderr, and no output for invalid input', async t => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'identity-import-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'export.json'); writeFileSync(file, JSON.stringify(sample()));
    const script = new URL('../scripts/import-users.mjs', import.meta.url);
    const good = spawnSync(process.execPath, [script.pathname, file], { encoding: 'utf8' });
    assert.equal(good.status, 0); assert.match(good.stdout, /INSERT INTO users/); assert.match(good.stderr, /no network calls/);
    writeFileSync(file, '{invalid');
    const bad = spawnSync(process.execPath, [script.pathname, file], { encoding: 'utf8' });
    assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
});
