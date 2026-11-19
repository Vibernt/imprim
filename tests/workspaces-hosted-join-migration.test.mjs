import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('migration 0027 leaves existing clients opted out and existing requests unbound', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('PRAGMA foreign_keys=ON');
        const root = new URL('../apps/server/migrations/', import.meta.url);
        const apply = name => db.exec('BEGIN;\n' + readFileSync(new URL(name, root), 'utf8') + '\nCOMMIT;');
        for (const name of readdirSync(root).filter(name => /^00(?:[01]\d|2[0-6])_.*\.sql$/.test(name)).sort()) apply(name);
        db.exec(`INSERT INTO clients(id,redirect_uris,workspaces,product,workspace_admin) VALUES
            ('existing','["https://app.example/callback"]','shared','notes','on');
            INSERT INTO auth_requests(id,client_id,redirect_uri,state,nonce,challenge,scope,browser_hash,expires_at)
                VALUES('pending','existing','https://app.example/callback','state','nonce','challenge','openid','browser',10000);`);
        apply('0027_join_workspaces.sql');
        assert.deepEqual(Object.values(db.prepare('SELECT workspace_admin,join_workspaces FROM clients').get()), ['on', 'off']);
        assert.deepEqual(Object.values(db.prepare('SELECT browser_hash,workspace_join FROM auth_requests').get()), ['browser', null]);
        assert.throws(() => db.exec("UPDATE clients SET join_workspaces='yes'"), /CHECK/);
        assert.throws(() => db.exec("UPDATE clients SET join_workspaces=NULL"), /NOT NULL/);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
});
