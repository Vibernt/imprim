// Ported from Assay tests/support/sqlite.mjs: real SQLite, D1-shaped API, atomic batch rollback.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
export function d1Database() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    const root = new URL('../../apps/server/migrations/', import.meta.url);
    // D1 applies each migration file in one transaction; deferred foreign keys are checked at its commit.
    for (const name of readdirSync(root).filter(x => x.endsWith('.sql')).sort()) {
        db.exec('BEGIN');
        try { db.exec(readFileSync(new URL(name, root), 'utf8')); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw new Error(`${name}: ${error.message}`); }
    }
    const statement = (sql, args = []) => ({
        bind(...values) { return statement(sql, values); },
        async first() { return db.prepare(sql).get(...args) || null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
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
