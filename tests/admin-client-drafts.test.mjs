import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';
import { adminLogin } from './support/admin.mjs';
import { basic, turnstile, world } from './support/world.mjs';

const draftPath = 'clients/editor/drafts';
const draft = {
    id: 'team-notes',
    branding: { name: 'Team notes' },
    redirect_uris: ['https://notes.example.com/callback'],
    sign_in_methods: ['email', 'passkey']
};
const activate = { version: 0, backchannel_uri: 'https://notes.example.com/backchannel' };

test('registration reserves an inactive draft and activates it atomically with a validated back-channel URL', async t => {
    const w = await world(t), db = w.env.DB.db;
    turnstile(t);
    const admin = await adminLogin(w);
    db.prepare("UPDATE admins SET role='realm'").run();
    const create = await admin.post(draftPath, draft);
    assert.equal(create.status, 200, await create.clone().text());
    assert.deepEqual(await create.json(), { id: draft.id });
    const path = 'clients/' + draft.id;
    assert.equal(db.prepare('SELECT count(*) AS n FROM clients WHERE id=?').get(draft.id).n, 0);
    assert.equal((await w.authorize({ client_id: draft.id, redirect_uri: draft.redirect_uris[0] })).status, 400);
    assert.equal((await w.exchange('unissued', { redirect_uri: draft.redirect_uris[0] }, basic(draft.id))).status, 401);
    const detail = await (await admin.get(path)).json();
    assert.equal(detail.draft, true);
    assert.equal(detail.backchannel_uri, null);
    assert.equal(detail.confidential, false);
    assert.deepEqual(detail.sign_in_methods, draft.sign_in_methods);
    assert.ok((await (await admin.get('clients')).json()).clients.every(client => client.id !== draft.id));
    assert.ok((await (await admin.get('clients?include_drafts=1')).json()).clients.some(client => client.id === draft.id && client.draft));
    assert.equal((await admin.post(path + '/rotate-secret', {})).status, 404);
    assert.equal((await admin.post(path, activate)).status, 404);
    assert.equal((await admin.post('clients', { ...draft, backchannel_uri: activate.backchannel_uri })).status, 409);
    assert.equal((await admin.post(draftPath, draft)).status, 409);
    assert.equal((await admin.post(path + '/activate', { version: 0 })).status, 400);
    assert.equal((await admin.post(path + '/activate', { ...activate, version: 1 })).status, 409);
    assert.equal((await admin.post(path + '/activate', { ...activate, backchannel_uri: 'http://notes.example.com' })).status, 400);
    assert.equal((await (await admin.get(path)).json()).draft, true);

    const responses = await Promise.all([
        admin.post(path + '/activate', activate), admin.post(path + '/activate', activate)
    ]);
    const successes = responses.filter(result => result.ok);
    assert.equal(successes.length, 1);
    assert.ok([404, 409].includes(responses.find(result => !result.ok).status));
    const { client, client_secret } = await successes[0].json();
    assert.equal(client.id, draft.id);
    assert.equal(client.version, 1);
    assert.equal(client.backchannel_uri, activate.backchannel_uri);
    assert.equal(db.prepare('SELECT secret_hash FROM clients WHERE id=?').get(draft.id).secret_hash, await sha256(client_secret));
    assert.equal(db.prepare('SELECT count(*) AS n FROM client_drafts WHERE id=?').get(draft.id).n, 0);
    assert.equal((await w.authorize({ client_id: draft.id, redirect_uri: draft.redirect_uris[0] })).status, 200);
    const active = await (await admin.get(path)).json();
    assert.equal(active.draft, undefined);
    assert.ok(!Object.hasOwn(active, 'client_secret') && !Object.hasOwn(active, 'secret_hash'));
    const audit = db.prepare('SELECT event,detail FROM audit WHERE target=? ORDER BY id').all(draft.id);
    assert.deepEqual(audit.map(event => event.event), ['admin_client_draft_create', 'admin_client_activate']);
    assert.ok(!JSON.stringify(audit).includes(client_secret));
});

test('draft registration rejects invalid essentials and foreign draft IDs cannot be read or activated', async t => {
    const w = await world(t), db = w.env.DB.db;
    turnstile(t);
    const admin = await adminLogin(w);
    db.prepare("INSERT INTO realms(id,issuer,display_name,config,created) VALUES('foreign','https://foreign.example.com','Foreign','{}',0)").run();
    db.prepare("INSERT INTO client_drafts(id,realm_id,configuration) VALUES('foreign-draft','foreign',?)").run(JSON.stringify(draft));
    assert.equal((await admin.get('clients/foreign-draft')).status, 404);
    assert.equal((await admin.post('clients/foreign-draft/activate', activate)).status, 404);
    assert.ok((await (await admin.get('clients?include_drafts=1')).json()).clients.every(client => client.id !== 'foreign-draft'));
    for (const invalid of [
        { id: 'bad/name' }, { redirect_uris: [] }, { redirect_uris: ['http://localhost/callback'] },
        { sign_in_methods: [] }, { sign_in_methods: ['email', 'email'] }, { branding: { name: ' ' } },
        { branding: { name: 'x'.repeat(201) } }, { backchannel_uri: activate.backchannel_uri }, { secret_hash: 'forbidden' },
    ]) assert.equal((await admin.post(draftPath, { ...draft, ...invalid })).status, 400, JSON.stringify(invalid));
    assert.equal((await admin.post(draftPath, { ...draft, id: 'app' })).status, 409);
    assert.equal((await admin.post(draftPath, { ...draft, id: 'foreign-draft' })).status, 409);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE event='admin_client_draft_create'").get().n, 0);
});
