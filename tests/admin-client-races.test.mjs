import test from 'node:test';
import assert from 'node:assert/strict';
import { world, turnstile } from './support/world.mjs';
import { adminLogin, clientConfig } from './support/admin.mjs';

for (const action of ['edit','rotate']) test(`client ${action} rolls back secret/configuration/version when its audit fails`, async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    await a.post('clients', clientConfig);
    const before = w.env.DB.db.prepare("SELECT * FROM clients WHERE id='notes'").get();
    w.env.DB.db.exec(`CREATE TRIGGER fail_client_audit BEFORE INSERT ON audit WHEN NEW.event='admin_client_${action === 'edit' ? 'update' : 'secret_rotate'}' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END`);
    const response = await a.post('clients/notes' + (action === 'rotate' ? '/rotate-secret' : ''), action === 'edit' ? { version: before.version, signup_policy: 'open' } : {});
    assert.equal(response.status, 500);
    assert.deepEqual(w.env.DB.db.prepare("SELECT * FROM clients WHERE id='notes'").get(), before);
});
test('a concurrent secret rotation prevents stale client configuration from committing', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    const first = await (await a.post('clients', clientConfig)).json();
    const original = w.env.DB.batch;
    w.env.DB.batch = async statements => {
        w.env.DB.batch = original;
        assert.equal((await a.post('clients/notes/rotate-secret')).status, 200);
        return original(statements);
    };
    assert.equal((await a.post('clients/notes', { version: first.client.version, signup_policy: 'open' })).status, 409);
    const current = await (await a.get('clients/notes')).json();
    assert.equal(current.signup_policy, 'invited'); assert.equal(current.version, first.client.version + 1);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_client_update'").get().n, 0);
});
test('public conversion is an explicit checkbox and is enforced on HTML POST', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    w.env.DB.db.exec("UPDATE clients SET secret_hash=NULL WHERE id='app'");
    const html = await (await w.call('/admin/clients/app', { headers: { cookie: a.cookie } })).text();
    assert.match(html, /type="checkbox" name="make_confidential" value="true" required/);
    const submit = body => w.call('/admin/clients/app/rotate-secret', { method: 'POST', headers: { cookie: a.cookie, origin: w.env.ISSUER, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: a.csrf, ...body }) });
    assert.equal((await submit({})).status, 400);
    assert.equal((await submit({ make_confidential: 'false' })).status, 400);
    assert.equal((await submit({ make_confidential: 'true' })).status, 200);
    assert.equal((await (await a.get('clients/app')).json()).confidential, true);
});
