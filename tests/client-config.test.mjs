import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { clientSeedSql } from '../scripts/seed-client.mjs';
import { world } from './support/world.mjs';
const config = { id: 'seeded', secret_hash: null, redirect_uris: ['https://example.com/callback'], sign_in_methods: ['google','email'], google_hosted_domains: ['example.com'] };
test('offline client seed validates and preserves method order and hosted domains', async t => {
    const w = await world(t); w.env.DB.db.exec(clientSeedSql(config));
    const client = w.env.DB.db.prepare("SELECT * FROM clients WHERE id='seeded'").get();
    assert.deepEqual(JSON.parse(client.sign_in_methods), config.sign_in_methods);
    assert.deepEqual(JSON.parse(client.google_hosted_domains), config.google_hosted_domains);
    assert.throws(() => w.env.DB.db.exec(clientSeedSql(config)), /UNIQUE/);
    assert.ok(clientSeedSql({ ...config, google_hosted_domains: undefined }).includes("'[]'"));
});
for (const methods of [[], ['google','google'], ['SMS'], ['x'], ['Email'], 'google', null, undefined, [1]]) test(`client seed refuses invalid methods ${JSON.stringify(methods)}`, () => {
    assert.throws(() => clientSeedSql({ ...config, sign_in_methods: methods }), /sign_in_methods/);
});
for (const domains of [null, 'example.com', ['EXAMPLE.com'], ['*.example.com'], ['a..com'], ['-a.com'], ['a-.com'], ['example.com','example.com'], [1]])
    test(`client seed refuses invalid domains ${JSON.stringify(domains)}`, () => assert.throws(() => clientSeedSql({ ...config, google_hosted_domains: domains }), /google_hosted_domains/));
for (const field of ['sign_in_methods', 'google_hosted_domains']) test(`SQL rejects malformed ${field} on insert and update`, async t => {
    const w = await world(t);
    const invalid = field === 'sign_in_methods' ? ['[]','null','{}','["google","google"]','["SMS"]','["x"]','[1]','invalid'] : ['null','{}','["*.example.com"]','[1]','["a.com","a.com"]'];
    for (const value of invalid) {
        assert.throws(() => w.env.DB.db.prepare(`UPDATE clients SET ${field}=? WHERE id='app'`).run(value));
        assert.throws(() => w.env.DB.db.prepare(`INSERT INTO clients(id,redirect_uris,${field}) VALUES('invalid','[]',?)`).run(value));
    }
});
test('the sign-in-methods migration preserves existing state and foreign-key cascades', () => {
    const db = new DatabaseSync(':memory:');
    try {
        const read = name => readFileSync(new URL('../apps/server/migrations/' + name, import.meta.url), 'utf8');
        db.exec(read('0001_identity.sql'));
        db.exec(`INSERT INTO users(id,email,created) VALUES('imported','person@example.com',0);
        INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES('github','42','imported','person',0);
        INSERT INTO clients(id,redirect_uris) VALUES('app','["https://app.example/callback"]');
        INSERT INTO auth_requests VALUES('request','app','https://app.example/callback','state','nonce','challenge','openid','browser',9999999999999);
        INSERT INTO oauth_states VALUES('state','browser','verifier','request',9999999999999);
        INSERT INTO sessions VALUES('session','sid','imported','csrf','github',1,9999999999999);
        INSERT INTO codes VALUES('code','app','https://app.example/callback','challenge','nonce','openid','session',9999999999999);
        INSERT INTO access_tokens VALUES('access','session','app','openid',9999999999999);`);
        db.exec('BEGIN'); db.exec(read('0002_sign_in_methods.sql')); db.exec('COMMIT');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(db.prepare('SELECT sign_in_methods FROM clients').get().sign_in_methods, '["email","github"]');
        for (const table of ['users','user_identities','clients','auth_requests','oauth_states','sessions','codes','access_tokens']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1);
        assert.equal(db.prepare('SELECT provider FROM oauth_states').get().provider, 'github');
        assert.equal(db.prepare('SELECT user_id FROM user_identities').get().user_id, 'imported');
        db.exec("DELETE FROM sessions WHERE hash='session'");
        assert.equal(db.prepare('SELECT count(*) n FROM codes').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) n FROM access_tokens').get().n, 0);
    } finally { db.close(); }
});
test('the seed script takes the console\'s policy settings with the console\'s rules', async () => {
    const { clientSeedSql } = await import('../scripts/seed-client.mjs');
    const base = { id: 'seeded', secret_hash: null, redirect_uris: ['https://seeded.example/callback'], sign_in_methods: ['email'], backchannel_uri: 'https://seeded.example/backchannel' };
    const sql = clientSeedSql({ ...base, mfa: 'required', mfa_trusted_device_days: 30, agent_consent_mfa: 'required', agent_dpop: 'required', user_events: 'on' });
    for (const fragment of ["'required'", '30', "'on'"]) assert.ok(sql.includes(fragment), fragment);
    for (const bad of [{ mfa: 'always' }, { mfa_trusted_device_days: 91 }, { agent_dpop: 'yes' }, { user_events: true }, { token_exchange_from: { other: ['missing-scope'] } }])
        assert.throws(() => clientSeedSql({ ...base, ...bad }), /Invalid policy/, JSON.stringify(bad));
});
