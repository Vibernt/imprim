import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { admitted } from '../apps/server/src/services/admission.mjs';
import { adminLogin } from './support/admin.mjs';
import { basic, turnstile, world } from './support/world.mjs';

const run = (script, ...args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { encoding: 'utf8' });
function sql(...args) {
    const result = run('operator', ...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

function apply(db, output) {
    db.exec('BEGIN');
    try { db.exec(output); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
}

const audit = db => db.prepare("SELECT event,actor,target,detail,realm_id FROM audit WHERE actor='operator-cli' ORDER BY id").all()
    .map(row => ({ ...row, detail: JSON.parse(row.detail) }));

test('offline app invitations grant and revoke admission in the named realm and audit each successful change', async t => {
    const w = await world(t, 'invited'), db = w.env.DB.db;
    db.exec("INSERT INTO realms(id,display_name,created) VALUES('other-realm','Other',0)");
    const client = db.prepare("SELECT * FROM clients WHERE id='app'").get();
    const email = "o'neil@example.com";
    const add = ['invite', 'default', 'app', "O'Neil@Example.COM"];
    assert.throws(() => apply(db, sql('invite', 'other-realm', 'app', email)), /admin_assertions/);
    assert.equal(await admitted(w.env, client, email), false);
    for (const args of [add, add]) apply(db, sql(...args));
    assert.equal(await admitted(w.env, client, email), true);
    assert.equal(await admitted(w.env, db.prepare("SELECT * FROM clients WHERE id='other'").get(), email), false);
    assert.throws(() => apply(db, sql('uninvite', 'other-realm', 'app', email)), /admin_assertions/);
    apply(db, sql('uninvite', 'default', 'app', email));
    assert.equal(await admitted(w.env, client, email), false);
    assert.throws(() => apply(db, sql('uninvite', 'default', 'app', email)), /admin_assertions/);
    const registered = await w.post('/v1/invitations', { email }, '', { authorization: basic() });
    assert.equal(registered.status, 201);
    const appAudit = db.prepare("SELECT actor,target,detail FROM audit WHERE event='invitation_registered' AND actor='app'").get();
    assert.deepEqual({ ...appAudit }, { actor: 'app', target: null, detail: '{}' });
    assert.deepEqual(audit(db), ['invitation_registered', 'invitation_registered', 'invitation_revoked'].map(event => ({
        event, actor: 'operator-cli', target: appAudit.target, detail: { ...JSON.parse(appAudit.detail), source: 'operator-cli' }, realm_id: 'default'
    })));
});

test('a client policy change needs the reviewed version and increments it exactly once', async t => {
    const w = await world(t, 'invited'), db = w.env.DB.db;
    const args = ['client', 'signup-policy', 'default', 'app', 'open', '--version'];
    assert.throws(() => apply(db, sql(...args, '1')), /admin_assertions/);
    assert.throws(() => apply(db, sql('client', 'signup-policy', 'other-realm', 'app', 'open', '--version', '0')), /admin_assertions/);
    assert.deepEqual({ ...db.prepare("SELECT signup_policy,version FROM clients WHERE id='app'").get() },
        { signup_policy: 'invited', version: 0 });
    assert.deepEqual(audit(db), []);
    const reviewed = sql(...args, '0');
    assert.match(reviewed, /AND version=0;/);
    apply(db, reviewed);
    assert.deepEqual({ ...db.prepare("SELECT signup_policy,version FROM clients WHERE id='app'").get() },
        { signup_policy: 'open', version: 1 });
    assert.throws(() => apply(db, reviewed), /admin_assertions/);
    assert.deepEqual(audit(db), [{ event: 'admin_client_update', actor: 'operator-cli', target: 'app',
        detail: { fields: ['signup_policy'], source: 'operator-cli' }, realm_id: 'default' }]);
});

test('offline roster add and remove match the console target and detail', async t => {
    const w = await world(t), db = w.env.DB.db;
    turnstile(t);
    const admin = await adminLogin(w);
    const email = "O'Neil@Example.COM";
    const path = 'realms/default/admins';
    assert.equal((await admin.post(path, { email, role: 'realm' })).status, 200);
    assert.equal((await admin.post(path, { email, role: null })).status, 200);
    apply(db, sql('admins', 'add', 'default', email, 'realm'));
    apply(db, sql('admins', 'remove', 'default', email));
    const consoleAudits = db.prepare("SELECT event,target,detail FROM audit WHERE event LIKE 'admin_roster_%' AND actor!='operator-cli' ORDER BY id").all();
    assert.deepEqual(audit(db), consoleAudits.map(({ event, target, detail }) => ({
        event, target, actor: 'operator-cli', detail: { ...JSON.parse(detail), source: 'operator-cli' }, realm_id: 'default'
    })));
});

test('both roster generators guard admissions and memberships before adding a platform address', async t => {
    const w = await world(t), db = w.env.DB.db;
    const dir = mkdtempSync(join(tmpdir(), 'imprim-operator-'));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const file = join(dir, 'realm.json');
    db.exec(`INSERT INTO users(id,email,created) VALUES('member','member@example.com',0),('admitted','admitted@example.com',0);
        INSERT INTO client_admissions(user_id,client_id,created) VALUES('admitted','app',0);
        INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('team','default','team','Team',0);
        INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('team','member','member',0,0);
        INSERT INTO realms(id,display_name,created) VALUES('separate','Separate',0);`);
    for (const email of ['member@example.com', 'admitted@example.com']) {
        const args = ['admins', 'add', 'default', email, 'platform'];
        const output = sql(...args);
        assert.match(output, /no app admission or workspace membership/);
        assert.throws(() => apply(db, output), /admin_assertions/);
        writeFileSync(file, JSON.stringify({ id: 'default', issuer: w.env.ISSUER, display_name: 'Changed',
            update: true, admins: [{ email, role: 'platform' }] }));
        const realm = run('realm', file);
        assert.equal(realm.status, 0, realm.stderr);
        assert.throws(() => apply(db, realm.stdout), /admin_assertions/);
        assert.equal(db.prepare("SELECT display_name FROM realms WHERE id='default'").get().display_name, 'Vibernt');
        const override = run('realm', file, '--allow-app-user');
        assert.equal(override.status, 0, override.stderr);
        assert.ok(override.stdout.includes('-- ' + override.stderr.trim()));
        const overrideOperator = run('operator', ...args, '--allow-app-user');
        assert.equal(overrideOperator.status, 0, overrideOperator.stderr);
        assert.ok(overrideOperator.stdout.includes('-- ' + overrideOperator.stderr.trim()));
        apply(db, sql('admins', 'add', 'default', email, 'realm'));
        apply(db, overrideOperator.stdout);
        apply(db, sql('admins', 'remove', 'default', email));
        assert.throws(() => apply(db, sql('admins', 'remove', 'default', email)), /admin_assertions/);
    }
    apply(db, sql('admins', 'add', 'separate', 'admitted@example.com', 'platform'));
    assert.deepEqual(audit(db).map(({ event, target, detail }) => [event, target, detail.role, detail.source]), [
        ...Array.from({ length: 2 }, () => [
            ['admin_roster_set', 'default', 'realm', 'operator-cli'],
            ['admin_roster_set', 'default', 'platform', 'operator-cli'],
            ['admin_roster_remove', 'default', null, 'operator-cli']
        ]).flat(),
        ['admin_roster_set', 'separate', 'platform', 'operator-cli']
    ]);
});

test('operator rejects invalid arguments and emits no SQL', () => {
    for (const args of [[], ['invite', 'bad realm', 'app', 'person@example.com'],
        ['invite', 'default', "app' OR 1=1", 'person@example.com'], ['invite', 'default', 'app', 'person@invalid'],
        ['uninvite', 'default', 'app'], ['admins', 'add', 'default', 'person@example.com', 'owner'],
        ['admins', 'add', 'default', 'person@example.com', 'realm', '--allow-app-user'],
        ['admins', 'remove', 'default', 'person@example.com', '--allow-app-user'],
        ['client', 'signup-policy', 'default', 'app', 'domains'], ['client', 'signup-policy', 'default', 'app', 'open', 'extra']]) {
        const result = run('operator', ...args);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Usage:/);
    }
});

test('signup-policy rejects a missing, malformed or unsafe reviewed version and prints usage', () => {
    const args = ['client', 'signup-policy', 'default', 'app', 'open'];
    const invalid = [[], ['--version'], ['--other', '0'], ['--version', '0', '--version', '1'],
        ...['', '-1', '1.5', '1e3', '0x1', '9007199254740992', '0 OR 1=1', '0\n'].map(value => ['--version', value])];
    for (const extra of invalid) {
        const result = run('operator', ...args, ...extra);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Usage:[\s\S]+<open\|invited> --version <n>/);
    }
});
