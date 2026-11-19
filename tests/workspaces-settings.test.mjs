import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { realmEnv, validateRealmConfig } from '../apps/server/src/realms/realm.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';
import { adminLogin, clientConfig } from './support/admin.mjs';
import { turnstile, world } from './support/world.mjs';

const SETTINGS = { product: 'notes-2', workspaces: 'shared', personal_workspaces: 'on', workspace_admin: 'on', self_signup: 'on', join_workspaces: 'on',
    initiate_login_uri: 'https://notes.example:443/login?source=invitation' };
const DEFAULTS = { product: null, workspaces: 'app', personal_workspaces: 'off', workspace_admin: 'off', self_signup: 'off', join_workspaces: 'off',
    initiate_login_uri: null };
const workspaceFields = client => Object.fromEntries(Object.keys(SETTINGS).map(name => [name, client[name]]));
const NEGATIVES = [
    [{ product: 'Notes' }, /Product must be/],
    [{ product: 'a' }, /Product must be/],
    [{ product: 'a'.repeat(41) }, /Product must be/],
    [{ product: ['notes'] }, /Product must be/],
    [{ workspaces: 'global' }, /Workspaces must be/],
    [{ workspaces: null }, /Workspaces must be/],
    [{ workspaces: 'shared' }, /require a product/],
    [{ personal_workspaces: 'yes' }, /Personal workspaces must be/],
    [{ personal_workspaces: null }, /Personal workspaces must be/],
    [{ personal_workspaces: 'on' }, /require shared workspaces/],
    [{ workspace_admin: true }, /Workspace administration must be/],
    [{ workspace_admin: 'on' }, /require shared workspaces/],
    [{ self_signup: true }, /Self-serve sign-up must be/],
    [{ self_signup: 'on' }, /requires shared workspaces/],
    [{ self_signup: 'on', workspaces: 'shared' }, /require a product/],
    [{ join_workspaces: true }, /Workspace join at sign-in must be/],
    [{ join_workspaces: 'on' }, /requires shared workspaces/],
    [{ join_workspaces: 'on', workspaces: 'shared' }, /require a product/],
    [{ initiate_login_uri: 42 }, /initiate login URL/],
    [{ initiate_login_uri: 'https:notes.example' }, /initiate login URL/],
    [{ initiate_login_uri: 'http://notes.example/login' }, /initiate login URL/],
    [{ initiate_login_uri: 'https://notes.example:8443/login' }, /initiate login URL/],
    [{ initiate_login_uri: 'https://notes.example.evil/login' }, /initiate login URL/],
    [{ initiate_login_uri: 'https://pass@notes.example/login' }, /initiate login URL/],
    [{ initiate_login_uri: 'https://notes.example/login\n' }, /initiate login URL/],
    [{ post_logout_uris: ['https://logout.example/cb'], initiate_login_uri: 'https://logout.example/login' }, /initiate login URL/],
];

test('workspace policy is validated on the console and in the seed script', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const seeded = { ...clientConfig, secret_hash: null, sign_in_methods: ['email'] };
    for (const [index, [fields, message]] of NEGATIVES.entries()) {
        const body = { ...clientConfig, ...fields, id: `rejected-${index}` };
        const response = await admin.post('clients', body);
        assert.equal(response.status, 400, JSON.stringify(fields));
        assert.match((await response.json()).error_description, message);
        assert.throws(() => clientSeedSql({ ...seeded, ...fields }), message);
    }
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM clients WHERE id LIKE 'rejected-%'").get().n, 0);
    for (const [id, fields] of [['seed-default', {}], ['seed-null', DEFAULTS], ['seed-shared', SETTINGS]]) {
        w.env.DB.db.exec(clientSeedSql({ ...seeded, id, ...fields }));
        const row = w.env.DB.db.prepare('SELECT * FROM clients WHERE id=?').get(id);
        assert.deepEqual(workspaceFields(row), { ...DEFAULTS, ...fields });
    }
    assert.deepEqual(workspaceFields(await (await admin.get('clients/app')).json()), DEFAULTS);
});

test('the Fire editor posts workspace settings through the guarded client write', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const form = { editor: '1', id: clientConfig.id, redirect_uris: clientConfig.redirect_uris[0], backchannel_uri: clientConfig.backchannel_uri,
        'sign_in_methods.email': '1', 'agent_registration_methods.metadata_document': '1', ...SETTINGS };
    const post = (path, fields, headers = {}, csrf = admin.csrf) => w.call(path, { method: 'POST', headers: {
        origin: w.env.ISSUER, cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers,
    }, body: new URLSearchParams({ csrf, ...fields }) });
    const { defaults } = await (await admin.get('clients/editor/defaults')).json();
    assert.deepEqual(workspaceFields(defaults), DEFAULTS);
    assert.equal((await post('/admin/clients', form, { origin: 'https://other.example' })).status, 403);
    assert.equal((await post('/admin/clients', form, {}, 'wrong')).status, 403);
    for (const fields of [{ product: 'Notes' }, { workspaces: 'app' }, { personal_workspaces: 'yes' },
        { workspace_admin: 'yes' }, { self_signup: 'yes' }, { join_workspaces: 'yes' }, { initiate_login_uri: 'https://other.example/login' }]) {
        assert.equal((await post('/admin/clients', { ...form, ...fields })).status, 400, JSON.stringify(fields));
    }
    const created = await post('/admin/clients', form);
    assert.equal(created.status, 200, await created.clone().text());
    const saved = await (await admin.get('clients/notes')).json();
    assert.deepEqual(workspaceFields(saved), SETTINGS);
    const rejected = await admin.post('clients/notes', { version: saved.version, redirect_uris: ['https://new.example/cb'] });
    assert.equal(rejected.status, 400, 'redirect edits are validated against the stored login URL');
    assert.deepEqual(workspaceFields(await (await admin.get('clients/notes')).json()), SETTINGS);
    const { id, workspace_admin, personal_workspaces, self_signup, join_workspaces, ...rest } = form;
    const cleared = { ...rest, workspaces: 'app', product: '', initiate_login_uri: '', version: String(saved.version) };
    assert.equal((await post('/admin/clients/notes', cleared)).status, 200);
    assert.equal((await post('/admin/clients/notes', cleared)).status, 409);
    assert.deepEqual(workspaceFields(await (await admin.get('clients/notes')).json()), DEFAULTS);
});

test('the realm switch is strict, defaults off, and reaches request environments through either configuration path', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const directory = mkdtempSync(join(tmpdir(), 'imprim-workspace-realm-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'realm.json');
    const script = fileURLToPath(new URL('../scripts/realm.mjs', import.meta.url));
    const input = { id: 'enabled', issuer: 'https://enabled.example', display_name: 'Enabled' };
    const run = config => {
        writeFileSync(file, JSON.stringify({ ...input, config }));
        return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    };
    const getRealm = id => w.env.DB.db.prepare('SELECT * FROM realms WHERE id=?').get(id);
    assert.equal(w.env.REALM.workspaces, 'off');
    assert.equal(realmEnv(w.env, { ...getRealm('default'), config: '{}' }).REALM.workspaces, 'off');
    for (const workspaces of [true, null, 'ON', 'enabled', '', { env: 'WORKSPACES' }]) {
        const config = { workspaces };
        assert.throws(() => validateRealmConfig(config), { code: 'realm_config' });
        assert.throws(() => realmEnv(w.env, { ...getRealm('default'), config: JSON.stringify(config) }), { code: 'realm_config' });
        const generated = run(config);
        assert.equal(generated.status, 1);
        assert.equal(generated.stdout, '');
        assert.match(generated.stderr, /Realm workspaces must be on or off/);
        const response = await admin.post('realms', { ...input, config });
        assert.equal(response.status, 400);
        assert.equal(getRealm(input.id), undefined);
    }
    for (const config of [{ workspaces: 'on', signup: 'yes' }, { workspaces: 'on', signup: 'on' }, { signup: 'approval' }, { workspaces: 'off', signup: 'open' }]) {
        assert.throws(() => validateRealmConfig(config), { code: 'realm_config' });
        assert.equal(run(config).status, 1);
        assert.equal((await admin.post('realms', { ...input, config })).status, 400);
    }
    for (const workspaces of ['on', 'off']) assert.deepEqual(validateRealmConfig({ workspaces }), { workspaces });
    const generated = run({ workspaces: 'on', signup: 'open' });
    assert.equal(generated.status, 0, generated.stderr);
    w.env.DB.db.exec(generated.stdout);
    assert.equal(realmEnv(w.env, getRealm(input.id)).REALM.workspaces, 'on');
    assert.equal(realmEnv(w.env, getRealm(input.id)).REALM.signup, 'open');
    const approval = await admin.post(`realms/${input.id}`, { version: getRealm(input.id).version, config: { workspaces: 'on', signup: 'approval' } });
    assert.equal(approval.status, 200, await approval.clone().text());
    assert.equal(realmEnv(w.env, getRealm(input.id)).REALM.signup, 'approval');
    const response = await admin.post(`realms/${input.id}`, { version: getRealm(input.id).version, config: { workspaces: 'off', signup: 'off' } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(realmEnv(w.env, getRealm(input.id)).REALM.workspaces, 'off');
    assert.equal(realmEnv(w.env, getRealm(input.id)).REALM.signup, 'off');
    assert.equal(realmEnv(w.env, getRealm('default')).REALM.signup, 'off');
    assert.equal(realmEnv(w.env, getRealm('default')).REALM.workspaces, 'off');
});
