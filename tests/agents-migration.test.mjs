import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { agentWorld, metadataId, resource, error } from './support/agents.mjs';

test('the agent-access migration preserves existing identities, clients, sessions and pending requests', () => {
    const db = new DatabaseSync(':memory:');
    const read = name => readFileSync(new URL('../apps/server/migrations/' + name, import.meta.url), 'utf8');
    try {
        for (const name of ['0001_identity.sql','0002_sign_in_methods.sql','0003_retired_signing_keys.sql']) db.exec(read(name));
        db.exec(`INSERT INTO users(id,email,created) VALUES('imported-principal','person@example.com',0);
            INSERT INTO clients(id,redirect_uris) VALUES('app','["https://app.example/callback"]');
            INSERT INTO sessions(hash,sid,user_id,csrf_hash,method,auth_time,expires_at) VALUES('session','sid','imported-principal','csrf','email',1,9999999999999);
            INSERT INTO auth_requests(id,client_id,redirect_uri,state,nonce,challenge,scope,browser_hash,expires_at)
                VALUES('request','app','https://app.example/callback','state','nonce','challenge','openid','browser',9999999999999);`);
        db.exec('BEGIN'); db.exec(read('0004_agent_access.sql')); db.exec('COMMIT');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        const app = db.prepare('SELECT * FROM clients').get();
        assert.equal(app.agent_access, 'off'); assert.equal(app.agent_max_grant_days, 90);
        assert.equal(app.agent_registration_methods, '["metadata_document"]');
        assert.equal(db.prepare('SELECT user_id FROM sessions').get().user_id, 'imported-principal');
        assert.equal(db.prepare('SELECT agent_client_id FROM auth_requests').get().agent_client_id, null);
        for (const clause of ["agent_access='yes'", 'agent_max_grant_days=0', 'agent_max_grant_days=1.5', "agent_resource_prefixes='invalid'"])
            assert.throws(() => db.exec('UPDATE clients SET ' + clause));
    } finally { db.close(); }
});

test('competing prefix inserted at issuance blocks ambiguous resource ownership', async t => {
    const w = await agentWorld(t), flow = await w.start();
    const batch = w.env.DB.batch;
    w.env.DB.batch = async statements => {
        w.env.DB.db.exec(`UPDATE clients SET agent_resource_prefixes='["https://app.example/w/"]' WHERE id='other'`);
        return batch(statements);
    };
    assert.ok((await w.approve(flow)).status >= 400);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 0);
});

test('metadata freshness rechecks removed redirect/grant types and changed policy during network', async t => {
    const w = await agentWorld(t), flow = await w.start();
    w.env.DB.db.exec('DELETE FROM agent_metadata_cache');
    w.network.document = { ...w.network.document, redirect_uris: ['https://agent.example/new'] };
    await error(await w.approve(flow), 'invalid_request');
    w.network.document = { ...w.network.document, redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['refresh_token'] };
    w.env.DB.db.exec('DELETE FROM agent_metadata_cache');
    await error(await w.approve(flow), 'unauthorized_client');
    w.env.DB.db.exec('DELETE FROM agent_metadata_cache');
    const previous = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const response = await previous(url, init);
        if (url === metadataId) w.env.DB.db.exec("UPDATE clients SET agent_access='off' WHERE id='app'");
        return response;
    });
    await error((await w.start()).response, 'access_denied');
});

test('consent escapes untrusted names, workspace labels and scope descriptions', async t => {
    const w = await agentWorld(t); w.network.document = { ...w.network.document, client_name: '<script>evil</script>' };
    w.env.DB.db.exec(`UPDATE clients SET agent_scope_catalogue='{"read":"<img src=x onerror=evil>"}' WHERE id='app'`);
    const flow = await w.start({ resource: resource.replace('team-one', '%3Cscript%3E') });
    const response = await w.call('/agent/consent?request_id=' + flow.id, { headers: { cookie: flow.cookie } });
    const html = await response.text();
    assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html.split('<main class="fd-page">')[1], /<script>|<img/);
});
