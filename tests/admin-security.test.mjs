import test from 'node:test';
import assert from 'node:assert/strict';
import { world, turnstile } from './support/world.mjs';
import { adminLogin, clientConfig } from './support/admin.mjs';
import { ensureUser, isAdmin } from '../apps/server/src/services/admission.mjs';

async function setup(t) {
    const w = await world(t); turnstile(t);
    return { w, a: await adminLogin(w) };
}
test('merge API requires exact source email confirmation and never accepts survivor email', async t => {
    const { w, a } = await setup(t), source = await ensureUser(w.env, 'source@example.com'), survivor = await ensureUser(w.env, 'survivor@example.com');
    for (const confirm of [undefined, '', survivor.email, 'wrong@example.com']) {
        assert.equal((await a.post(`users/${source.id}/merge`, { surviving_id: survivor.id, confirm_source_email: confirm })).status, 400);
        assert.equal(w.env.DB.db.prepare('SELECT status FROM users WHERE id=?').get(source.id).status, 'active');
        assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_merge'").get().n, 0);
    }
    assert.equal((await a.post(`users/${source.id}/merge`, { surviving_id: survivor.id, confirm_source_email: source.email })).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT merged_into FROM users WHERE id=?').get(source.id).merged_into, survivor.id);
});
test('merge console reviews both emails before explicit destructive confirmation', async t => {
    const { w, a } = await setup(t), source = await ensureUser(w.env, 'source@example.com'), survivor = await ensureUser(w.env, 'survivor@example.com');
    const page = await w.call(`/admin/users/${source.id}`, { headers: { cookie: a.cookie } });
    const html = await page.text(); assert.match(html, /Merge this user into another: this user is deleted/);
    assert.doesNotMatch(html, /Merge into this user/);
    const preview = await w.call(`/admin/users/${source.id}/merge?surviving_id=${survivor.id}`, { headers: { cookie: a.cookie } });
    assert.equal(preview.status, 200);
    const confirmation = await preview.text();
    for (const email of [source.email, survivor.email]) assert.ok(confirmation.includes(email));
    assert.match(confirmation, /name="confirm_source_email"/);
    assert.equal(w.env.DB.db.prepare('SELECT status FROM users WHERE id=?').get(source.id).status, 'active');
    const submit = async email => w.call(`/admin/users/${source.id}/merge`, { method: 'POST', headers: { cookie: a.cookie, origin: w.env.ISSUER, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: a.csrf, surviving_id: survivor.id, confirm_source_email: email }) });
    assert.equal((await submit(survivor.email)).status, 400);
    assert.equal((await submit(source.email)).status, 200);
});
test('client edits require a version; concurrent edits have one winner and stale forms return 409', async t => {
    const { w, a } = await setup(t);
    const created = await (await a.post('clients', clientConfig)).json(), version = created.client.version ?? 0;
    const changes = [{ branding: { name: 'First' } }, { signup_policy: 'open' }];
    const responses = await Promise.all(changes.map(change => a.post('clients/touchstone', { ...change, version })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200,409]);
    const current = await (await a.get('clients/touchstone')).json(); assert.equal(current.version, version + 1);
    const firstWon = responses[0].status === 200;
    assert.equal(current.branding.name, firstWon ? 'First' : clientConfig.branding.name);
    assert.equal(current.signup_policy, firstWon ? 'invited' : 'open');
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_client_update'").get().n, 1);
    assert.equal((await a.post('clients/touchstone', { branding: { name: 'Missing version' } })).status, 400);
    assert.equal((await a.post('clients/touchstone', { version, branding: { name: 'Stale' } })).status, 409);
    const html = await (await w.call('/admin/clients/touchstone', { headers: { cookie: a.cookie } })).text();
    assert.match(html, new RegExp(`type="hidden" name="version" value="${current.version}"`));
    const form = await w.call('/admin/clients/touchstone', { method: 'POST', headers: { cookie: a.cookie, origin: w.env.ISSUER, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: a.csrf, version: String(version), signup_policy: 'open' }) });
    assert.equal(form.status, 409);
});
test('public secret rotation requires explicit conversion and audits it; rotation invalidates stale editors', async t => {
    const { w, a } = await setup(t);
    await a.post('clients', clientConfig);
    w.env.DB.db.exec("UPDATE clients SET secret_hash=NULL WHERE id='touchstone'");
    for (const body of [{}, { make_confidential: false }, { make_confidential: 'true' }]) {
        assert.equal((await a.post('clients/touchstone/rotate-secret', body)).status, 400);
        assert.equal(w.env.DB.db.prepare("SELECT secret_hash FROM clients WHERE id='touchstone'").get().secret_hash, null);
    }
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_client_secret_rotate'").get().n, 0);
    const before = await (await a.get('clients/touchstone')).json();
    const response = await a.post('clients/touchstone/rotate-secret', { make_confidential: true }); assert.equal(response.status, 200);
    assert.ok((await response.json()).client_secret);
    const audit = w.env.DB.db.prepare("SELECT detail FROM audit WHERE event='admin_client_secret_rotate'").get();
    assert.equal(JSON.parse(audit.detail).made_confidential, true);
    assert.equal((await a.post('clients/touchstone', { version: before.version, signup_policy: 'open' })).status, 409);
});
test('mixed-case stored admin email retains admin access and matches roster', async t => {
    const { w, a } = await setup(t);
    w.env.DB.db.exec("UPDATE users SET email='Admin@Example.COM' WHERE email='admin@example.com'");
    assert.equal(await isAdmin(w.env, 'Admin@Example.COM'), true);
    assert.equal((await a.get('clients')).status, 200);
});
test('blocking a mixed-case account deletes all case variants of pending magic links', async t => {
    const { w, a } = await setup(t), user = await ensureUser(w.env, 'person@example.com');
    w.env.DB.db.prepare("UPDATE users SET email='Person@Example.COM' WHERE id=?").run(user.id);
    for (const [i,email] of ['person@example.com','PERSON@example.com'].entries())
        w.env.DB.db.prepare('INSERT INTO magic_links(hash,email,browser_hash,expires_at) VALUES(?,?,?,?)').run('hash'+i,email,'browser',Date.now()+60000);
    assert.equal((await a.post(`users/${user.id}/block`)).status, 200);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM magic_links').get().n, 0);
});
test('malformed percent encoding in admin paths returns 400', async t => {
    const { w, a } = await setup(t);
    for (const path of ['/admin/users/%','/admin/api/clients/%E0%A4%A']) {
        const response = await w.call(path, { headers: { cookie: a.cookie } }); assert.equal(response.status, 400);
    }
});
