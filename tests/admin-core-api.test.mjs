import test from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, clientConfig } from './support/admin.mjs';
import { login, world } from './support/world.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { useWebShell } from './support/web-shell.mjs';

const reads = ['clients', 'clients?include_drafts=1', 'clients/app', 'clients/editor/defaults', 'services', 'users', 'users/someone',
    'users/someone/merge?surviving_id=other', 'audit', 'audit?event=admin_sign_in&from=2026-01-01', 'audit/export', 'signups', 'signups/summary', 'settings'];
const writes = ['clients', 'clients/editor/drafts', 'clients/someone/activate', 'clients/app', 'clients/app/rotate-secret', 'services', 'services/worker', 'services/worker/delete',
    ...['block', 'unblock', 'delete', 'merge', 'revoke-session', 'reset-mfa'].map(action => 'users/someone/' + action)];
const get = (w, path, cookie = '') => w.call('/admin/api/' + path, { headers: { cookie } });

async function problem(response, status, error, label) {
    assert.equal(response.status, status, label);
    const body = await response.json();
    assert.equal(body.error, error, label);
    assert.equal(typeof body.error_description, 'string', label);
}

test('all admin core reads and writes require a scoped administrator, second factor and write freshness', async t => {
    const w = await world(t), { cookie: person } = await login(w, t), admin = await adminLogin(w);
    const db = w.env.DB.db, denied = async (paths, call, status, error) => {
        for (const path of paths) await problem(await call(path), status, error, path);
    };
    for (const [cookie, status, code] of [['', 401, 'login_required'], [person, 403, 'admin_required']]) {
        await denied(reads, path => get(w, path, cookie), status, code);
        await denied(writes, path => admin.post(path, {}, { cookie }), status, code);
    }
    for (const [headers, code] of [
        [{ 'x-csrf-token': '' }, 'csrf'], [{ 'x-csrf-token': 'wrong' }, 'csrf'],
        [{ origin: '' }, 'origin'], [{ origin: 'https://other.example' }, 'origin'],
    ]) await denied(writes, path => admin.post(path, {}, headers), 403, code);

    db.exec('UPDATE sessions SET mfa_at=0 WHERE admin_until IS NOT NULL');
    await denied(reads, admin.get, 403, 'mfa_required');
    await denied(writes, admin.post, 403, 'mfa_required');
    db.prepare('UPDATE sessions SET mfa_at=? WHERE admin_until IS NOT NULL').run(Date.now() - 3600001);
    await denied(reads, admin.get, 403, 'mfa_required');
    await denied(writes, admin.post, 403, 'mfa_required');

    db.prepare('UPDATE sessions SET mfa_at=?, auth_time=? WHERE admin_until IS NOT NULL').run(Date.now(), Math.floor(Date.now() / 1000) - 601);
    assert.equal((await admin.get('clients/editor/defaults')).status, 200, 'freshness is a write guard');
    await denied(writes, admin.post, 403, 'reauth_required');

    db.exec('UPDATE sessions SET admin_until=0 WHERE admin_until IS NOT NULL');
    await denied(reads, admin.get, 403, 'reauth_required');
    assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE event LIKE 'admin_%' AND event!='admin_sign_in'").get().n, 0);
});

test('core API lookups and writes use the admin realm and session owner', async t => {
    const w = await world(t), person = await login(w, t), admin = await adminLogin(w);
    const db = w.env.DB.db;
    db.exec(`INSERT INTO realms(id,issuer,display_name,config,created) VALUES('foreign','https://foreign.example','Foreign','{}',0);
        INSERT INTO users(id,email,realm_id,created) VALUES('foreign-user','foreign@example.com','foreign',0);
        INSERT INTO clients(id,realm_id,redirect_uris) VALUES('foreign-app','foreign','["https://foreign.example/callback"]');
        INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,status,created,updated)
        VALUES('foreign-service','foreign','foreign-app','Foreign','foreign@example.com','{}','[]','[]','active',0,0);
        INSERT INTO audit(id,event,target,detail,created,realm_id) VALUES(9999,'foreign_event','foreign-user','{}',0,'foreign');`);
    for (const path of ['clients/foreign-app', 'users/foreign-user', 'users/foreign-user/merge?surviving_id=foreign-user'])
        await problem(await admin.get(path), 404, 'not_found', path);
    for (const path of ['clients/foreign-app', 'clients/foreign-app/rotate-secret', 'services/foreign-service',
        'services/foreign-service/delete', 'users/foreign-user/block', 'users/foreign-user/reset-mfa'])
        await problem(await admin.post(path, path.endsWith('/reset-mfa') ? { reason: 'Test reason' } : {}), 404, 'not_found', path);
    assert.ok((await (await admin.get('clients')).json()).clients.every(client => client.id !== 'foreign-app'));
    assert.ok((await (await admin.get('users')).json()).users.every(user => user.id !== 'foreign-user'));
    assert.deepEqual((await (await admin.get('services')).json()).services, []);
    assert.deepEqual((await (await admin.get('audit?target=foreign-user')).json()).audit, []);
    assert.doesNotMatch(await (await admin.get('audit/export')).text(), /foreign_event/);

    const someone = await ensureUser(w.env, 'someone@example.com'), stranger = await ensureUser(w.env, 'stranger@example.com');
    const { session } = await issueSession(w.env, stranger, 'email');
    await problem(await admin.post(`users/${someone.id}/revoke-session`, { sid: session.sid }), 404, 'not_found');
    await problem(await admin.get(`users/${someone.id}/merge?surviving_id=foreign-user`), 404, 'not_found');
    assert.equal((await get(w, 'users/' + someone.id, person.cookie)).status, 403);
    assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE event='admin_service_delete' OR event='admin_revoke_session'").get().n, 0);
});

test('client editor defaults are read-only and rotation checks the displayed client version', async t => {
    const w = await world(t);
    await login(w, t);
    const admin = await adminLogin(w);
    const defaults = await admin.get('clients/editor/defaults');
    assert.equal(defaults.status, 200);
    assert.equal(defaults.headers.get('cache-control'), 'no-store');
    const setup = await defaults.json();
    assert.deepEqual(setup.defaults.sign_in_methods, ['email']);
    assert.equal(setup.defaults.agent_access, 'off');
    assert.equal(setup.defaults.version, undefined);
    assert.equal(setup.defaults.secret_hash, undefined);
    assert.equal((await admin.post('clients/editor/defaults', {})).status, 404);
    const { client } = await (await admin.post('clients', clientConfig)).json();
    await problem(await admin.post('clients/notes/rotate-secret', { version: '0' }), 400, 'invalid_request');
    await problem(await admin.post('clients/notes/rotate-secret', { version: client.version + 1 }), 409, 'conflict');
    const rotated = await admin.post('clients/notes/rotate-secret', { version: client.version });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers.get('cache-control'), 'no-store');
    assert.ok((await rotated.json()).client_secret);
    const detail = await (await admin.get('clients/notes')).json();
    assert.equal(detail.version, client.version + 1);
    assert.deepEqual(setup.providers, detail.providers);
    assert.ok(!Object.hasOwn(detail, 'client_secret') && !Object.hasOwn(detail, 'secret_hash'));
    await problem(await admin.get('audit?before=bad'), 400, 'invalid_request');
    await problem(await admin.get('audit/export?after=bad'), 400, 'invalid_request');
});

test('admin document paths serve Lit, including direct merge review and filtered audit links', async t => {
    const w = await world(t);
    await login(w, t);
    const admin = await adminLogin(w);
    await useWebShell(t, w.env);
    const accept = 'text/html';
    for (const path of ['/admin', '/admin/clients', '/admin/clients/new', '/admin/clients/app', '/admin/services',
        '/admin/users', '/admin/users/example', '/admin/users/example/merge?surviving_id=other', '/admin/audit?target=example']) {
        const response = await w.call(path, { headers: { accept, cookie: admin.cookie } });
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(await response.text(), /<app-shell><\/app-shell>/);
        assert.equal((await w.call(path, { headers: { accept: 'application/json', cookie: admin.cookie } })).status, 404, path);
    }
    const signedOut = await w.call('/admin/audit?target=example', { headers: { accept } });
    assert.equal(signedOut.headers.get('location'), '/login?next=' + encodeURIComponent('/admin/audit?target=example'));
    w.env.DB.db.exec('UPDATE sessions SET mfa_at=0 WHERE admin_until IS NOT NULL');
    const requiresFactor = await w.call('/admin/audit?target=example', { headers: { accept, cookie: admin.cookie } });
    assert.equal(requiresFactor.headers.get('location'), '/mfa?next=' + encodeURIComponent('/admin/audit?target=example'));
});

test('users and audit keep search filters and cursor order across pages', async t => {
    const w = await world(t);
    await login(w, t);
    const admin = await adminLogin(w), db = w.env.DB.db;
    const insertUser = db.prepare("INSERT INTO users(id,email,realm_id,created) VALUES(?,?,'default',0)");
    const insertAudit = db.prepare("INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES('admin_paging',?,?,'{}',?,'default')");
    for (let i = 0; i < 51; i++) {
        insertUser.run('page-' + String(i).padStart(2, '0'), 'sample-' + i + '@example.com');
        insertAudit.run('operator', 'target', Date.now());
    }
    insertAudit.run('operator', 'elsewhere', Date.now());
    insertAudit.run('other', 'target', Date.now());

    const first = await (await admin.get('users?q=SaMpLe-')).json();
    const last = await (await admin.get('users?q=SaMpLe-&before=' + first.next)).json();
    assert.equal(first.total, 51);
    assert.equal(last.total, 51);
    assert.equal(first.users.length, 50);
    assert.equal(first.next, 'page-01');
    assert.deepEqual(last.users.map(user => user.id), ['page-00']);
    assert.equal(last.next, null);
    assert.equal((await (await admin.get('users?q=page-20')).json()).users[0].id, 'page-20');

    const audit = await (await admin.get('audit?actor=operator&target=target')).json();
    const older = await (await admin.get('audit?actor=operator&target=target&before=' + audit.next)).json();
    assert.equal(audit.audit.length, 50);
    assert.equal(audit.next, audit.audit.at(-1).id);
    assert.equal(older.audit.length, 1);
    assert.ok(older.audit[0].id < audit.next);
    assert.ok([...audit.audit, ...older.audit].every(row => row.actor === 'operator' && row.target === 'target'));
    assert.equal(older.next, null);
});
