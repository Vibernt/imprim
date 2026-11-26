import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('migration 0032 keeps admissions and backfills only each person’s most recent recorded sign-in per app', t => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const root = new URL('../apps/server/migrations/', import.meta.url);
    const migration = '0032_account_activity.sql';
    const apply = name => db.exec(`BEGIN;\n${readFileSync(new URL(name, root), 'utf8')}\nCOMMIT;`);
    for (const name of readdirSync(root).filter(name => name.endsWith('.sql') && name < migration).sort()) apply(name);
    db.exec(`INSERT INTO users(id,email,created) VALUES('person','person@example.com',0),('other','other@example.com',0);
        INSERT INTO clients(id,redirect_uris) VALUES('app','[]'),('unseen','[]');
        INSERT INTO client_admissions(user_id,client_id,created,source) VALUES
            ('person','app',1,'workspace'),('person','unseen',2,'app'),('other','unseen',3,'app');
        INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES
            ('app','person','first',101),('app','person','later',202),('unseen','other','own',303);`);
    apply(migration);
    const rows = db.prepare('SELECT user_id,client_id,created,source,last_signed_in FROM client_admissions ORDER BY created').all();
    assert.deepEqual(rows.map(Object.values), [
        ['person', 'app', 1, 'workspace', 202], ['person', 'unseen', 2, 'app', null], ['other', 'unseen', 3, 'app', 303],
    ]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM app_sessions').get().count, 3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
