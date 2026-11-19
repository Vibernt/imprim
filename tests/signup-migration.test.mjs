import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('migration 0025 preserves magic-link rows, constraints, indexes and request cascades', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('PRAGMA foreign_keys=ON');
        const root = new URL('../apps/server/migrations/', import.meta.url);
        const apply = name => db.exec('BEGIN;\n' + readFileSync(new URL(name, root), 'utf8') + '\nCOMMIT;');
        for (const name of readdirSync(root).filter(name => /^00(?:[01]\d|2[0-4])_.*\.sql$/.test(name)).sort()) apply(name);
        db.exec(`INSERT INTO realms(id,issuer,display_name,created) VALUES('brand','https://brand.example','Brand',0);
            INSERT INTO clients(id,realm_id,redirect_uris) VALUES('app','brand','["https://app.example/callback"]');
            INSERT INTO auth_requests(id,client_id,redirect_uri,state,nonce,challenge,scope,browser_hash,expires_at)
                VALUES('request','app','https://app.example/callback','state','nonce','challenge','openid','browser',10000);
            INSERT INTO magic_links(hash,email,request_id,browser_hash,expires_at,realm_id,purpose)
                VALUES('one','p@example.com','request','browser',5000,'brand','password'),
                ('two','a@example.com',NULL,'browser-admin',6000,'default','sign_in');
            INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('existing','brand','team','Existing',0);`);
        const rows = () => db.prepare('SELECT hash,email,request_id,browser_hash,expires_at,realm_id,purpose FROM magic_links ORDER BY hash').all();
        const indexes = () => db.prepare("PRAGMA index_list('magic_links')").all().map(({ name, origin }) => [name, origin]);
        const before = rows(), beforeIndexes = indexes();
        apply('0025_signup.sql');
        assert.deepEqual(rows(), before);
        assert.deepEqual(indexes(), beforeIndexes);
        assert.equal(db.prepare("PRAGMA index_info('magic_links_expiry')").get().name, 'expires_at');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(db.prepare('SELECT self_signup FROM clients').get().self_signup, 'off');
        assert.equal(db.prepare('SELECT created_via FROM workspaces').get().created_via, null);
        assert.throws(() => db.exec("UPDATE clients SET self_signup='yes'"), /CHECK/);
        assert.throws(() => db.exec("UPDATE workspaces SET created_via='import'"), /CHECK/);
        assert.throws(() => db.exec("UPDATE magic_links SET purpose='unknown'"), /CHECK/);
        db.exec(`INSERT INTO magic_links(hash,email,request_id,browser_hash,expires_at,realm_id,purpose,workspace_name)
            VALUES('three','b@example.com','request','browser',6000,'brand','signup','My team');`);
        assert.equal(db.prepare("SELECT workspace_name FROM magic_links WHERE hash='three'").get().workspace_name, 'My team');
        db.exec("DELETE FROM auth_requests WHERE id='request'");
        assert.deepEqual(rows(), [before[1]]);
    } finally { db.close(); }
});
