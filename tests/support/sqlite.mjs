// A D1-shaped API over real SQLite (node:sqlite), with atomic batch rollback.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
// `root` defaults to Imprim's migrations; the MCP probe example passes its own.
export function d1Database(root = new URL('../../apps/server/migrations/', import.meta.url)) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    // D1 applies each migration file in one transaction; deferred foreign keys are checked at its commit.
    for (const name of readdirSync(root).filter(x => x.endsWith('.sql')).sort()) {
        db.exec('BEGIN');
        try { db.exec(readFileSync(new URL(name, root), 'utf8')); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw new Error(`${name}: ${error.message}`); }
    }
    // D1 returns a BLOB column as an Array of numbers; node:sqlite returns a Uint8Array. Match D1.
    const shape = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? Array.from(value) : value]));
    const statement = (sql, args = []) => ({
        bind(...values) { return statement(sql, values); },
        async first() { return shape(db.prepare(sql).get(...args)) || null; },
        async all() { return { results: db.prepare(sql).all(...args).map(shape) }; },
        async run() { return { success: true, meta: { changes: db.prepare(sql).run(...args).changes } }; },
        batched() {
            const query = db.prepare(sql);
            const results = query.all(...args);
            return { success: true, results, meta: { changes: db.prepare('SELECT changes() AS n').get().n } };
        }
    });
    return { db, prepare: statement, async batch(list) {
        db.exec('BEGIN');
        try {
            const results = [];
            for (const stmt of list) results.push(stmt.batched());
            db.exec('COMMIT');
            return results;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
    } };
}
