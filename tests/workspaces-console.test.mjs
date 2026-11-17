import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world, turnstile } from './support/world.mjs';
import { adminLogin, assertFireMarkup } from './support/admin.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';

const root = '/admin/workspaces';
const adminEmail = 'admin@example.com';
const teamInput = { name: 'Team <example>', products: 'notes\ntasks', first_owner_email: adminEmail };

async function setup(t) {
    turnstile(t);
    const w = await world(t), db = w.env.DB.db;
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
        UPDATE admins SET role='realm';
        UPDATE clients SET workspaces='shared', product='notes', backchannel_uri='https://app.example/backchannel' WHERE id='app';
        UPDATE clients SET workspaces='shared', product='tasks', backchannel_uri='https://app.example/backchannel' WHERE id='other';`);
    const { cookie, csrf } = await adminLogin(w);
    const admin = db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail).id;
    const get = (path = root, headers = {}) => w.call(path, { headers: { cookie, ...headers } });
    const post = (path, input = {}, headers = {}) => w.call(path, { method: 'POST', headers: {
        cookie, origin: w.env.ISSUER, 'content-type': 'application/x-www-form-urlencoded', ...headers
    }, body: new URLSearchParams({ csrf, ...input }) });
    const create = async (input = teamInput) => {
        const response = await post(root, input);
        assert.equal(response.status, 303, await response.text());
        const path = response.headers.get('location');
        assert.match(path, /^\/admin\/workspaces\/ws_[0-9a-f]{32}$/);
        return { path, id: path.split('/').at(-1) };
    };
    return { ...w, db, admin, get, post, create };
}

async function rejected(response, status, code) {
    assert.equal(response.status, status, await response.clone().text());
    assert.equal((await response.json()).error, code);
}

test('a realm admin can manage a team through each Fire console form', async t => {
    const w = await setup(t), { db } = w;
    const createPage = await w.get(root + '?create=1');
    assert.equal(createPage.status, 200);
    const createHtml = await createPage.text();
    assertFireMarkup(createHtml);
    assert.match(createHtml, /name="first_owner_email"/);
    const { path, id } = await w.create();

    const member = await ensureUser(w.env, 'existing@example.com');
    db.prepare("INSERT INTO workspace_members VALUES(?,?,'member',0,0)").run(id, member.id);
    db.prepare("INSERT INTO workspace_resources VALUES(?,?,'app',0)").run('https://app.example/teams/example', id);
    const detail = await (await w.get(path)).text();
    assertFireMarkup(detail);
    for (const label of ['Team &lt;example&gt;', adminEmail, member.email, 'Registered resources',
        'https://app.example/teams/example', 'Holds', 'Recent audit', 'workspace-created']) assert.ok(detail.includes(label), label);
    assert.match(detail, /href="\/admin\/workspaces" aria-current="page"/);
    const forms = [...detail.matchAll(/<form[^>]*method="post"[^>]*>(.*?)<\/form>/gs)];
    assert.ok(forms.length > 0);
    assert.ok(forms.every(([, content]) => /name="csrf" value="[^"]+"/.test(content)));
    assert.equal(db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(id, w.admin).role, 'owner');

    const done = async (action, input) => {
        const response = await w.post(path + '/' + action, input);
        assert.equal(response.status, 303, await response.text());
        assert.equal(response.headers.get('location'), path);
    };
    await done('rename', { name: 'Renamed' });
    await done('products', { add: 'boards', remove: 'tasks' });
    const productEvents = db.prepare('SELECT client_id,payload FROM workspace_event_outbox WHERE workspace_id=? AND version=3 ORDER BY client_id').all(id);
    assert.deepEqual(productEvents.map(row => [row.client_id, JSON.parse(row.payload).products]), [
        ['app', ['boards', 'notes']], ['other', ['boards', 'notes']]
    ]);
    assert.match(await (await w.get(root)).text(), /Renamed.*Team.*Active.*boards.*notes.*>2</s);

    const mailCount = w.mails.length;
    await done('invite', { email: 'NEW@example.com', role: 'viewer' });
    const invitation = db.prepare('SELECT id,invited_by,via_client FROM workspace_invitations WHERE workspace_id=? AND email=?').get(id, 'new@example.com');
    assert.deepEqual([invitation.invited_by, invitation.via_client], [null, null]);
    assert.equal(w.mails.length, mailCount + 1);
    assert.equal(w.mails.at(-1).to, 'new@example.com');
    assert.match(w.mails.at(-1).text, /admin@example\.com/);
    assert.ok(w.mails.at(-1).html.includes(w.env.ISSUER + '/login'));
    assert.match(await (await w.get(path)).text(), /new@example\.com.*Viewer/s);
    w.db.exec("INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('unrelated','default','team','Unrelated',0)");
    await rejected(await w.post(root + '/unrelated/revoke-invitation', { invitation_id: invitation.id }), 404, 'not_found');
    await done('revoke-invitation', { invitation_id: invitation.id });
    assert.ok(db.prepare('SELECT revoked_at FROM workspace_invitations WHERE id=?').get(invitation.id).revoked_at);
    assert.doesNotMatch(await (await w.get(path)).text(), /new@example\.com/);

    await done('role', { sub: member.id, role: 'owner' });
    assert.equal(db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(id, member.id).role, 'owner');
    await done('remove-member', { sub: member.id });
    assert.equal(db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(id, member.id), undefined);

    const closeHtml = await (await w.get(path + '/close')).text();
    assertFireMarkup(closeHtml);
    assert.match(closeHtml, /Closing permanently ends access/);
    await done('close');
    const closed = await (await w.get(path)).text();
    assert.match(closed, /Closed/);
    assert.doesNotMatch(closed, /method="post"/);
    assert.deepEqual({ ...db.prepare('SELECT status,name,version FROM workspaces WHERE id=?').get(id) }, { status: 'closed', name: 'Renamed', version: 8 });
    const audit = db.prepare('SELECT event,actor,detail FROM audit WHERE target=? ORDER BY id').all(id);
    assert.deepEqual(audit.map(row => row.event), ['workspace-created', 'workspace-updated', 'workspace-products-changed',
        'workspace-invited', 'workspace-invitation-revoked', 'workspace-role-changed', 'workspace-member-removed', 'workspace-closed']);
    assert.ok(audit.every((row, i) => row.actor === w.admin && JSON.parse(row.detail).version === i + 1 && JSON.parse(row.detail).source === 'admin_console'));
    assert.deepEqual(db.prepare("SELECT version FROM workspace_event_outbox WHERE workspace_id=? AND client_id='app' ORDER BY version").all(id)
        .map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('console checks the session, MFA, reauthentication, CSRF, Origin and realm switch', async t => {
    const w = await setup(t);
    assert.equal((await w.get(root, { cookie: '' })).headers.get('location'), w.env.ISSUER + '/login');
    await rejected(await w.post(root, teamInput, { cookie: '' }), 403, 'admin_required');
    await rejected(await w.post(root, { ...teamInput, csrf: 'wrong' }), 403, 'csrf');
    await rejected(await w.post(root, teamInput, { origin: 'https://wrong.example' }), 403, 'origin');
    w.db.exec('UPDATE sessions SET auth_time=auth_time-601');
    await rejected(await w.post(root, teamInput), 403, 'reauth_required');
    w.db.exec('UPDATE sessions SET auth_time=auth_time+601, mfa_at=NULL');
    await rejected(await w.post(root, teamInput), 403, 'mfa_required');
    w.db.prepare('UPDATE sessions SET mfa_at=?').run(Date.now());

    w.db.exec("UPDATE realms SET config=json_remove(config,'$.workspaces') WHERE id='default'");
    for (const url of [root, root + '?create=1', root + '/existing']) {
        const response = await w.get(url);
        assert.equal(response.status, 200);
        const html = await response.text();
        assertFireMarkup(html);
        assert.match(html, /Shared workspaces are off/);
        assert.doesNotMatch(html, /method="post"|Create workspace/);
    }
    await rejected(await w.post(root, teamInput), 404, 'not_found');
    await rejected(await w.post(root + '/existing/rename', { name: 'Refused' }), 404, 'not_found');
    w.db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on');
        DELETE FROM mfa_factors WHERE user_id=(SELECT id FROM users WHERE email='admin@example.com')`);
    assert.match((await w.get(root)).headers.get('location'), /\/account\/mfa\?next=%2Fadmin%2Fworkspaces/);
    await rejected(await w.post(root, teamInput), 403, 'mfa_enrolment_required');
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspaces').get().n, 0);
});

test('workspace actions reject invalid input, wrong ownership, holds, personal invitations and foreign targets', async t => {
    const w = await setup(t), { db } = w;
    await rejected(await w.post(root, { ...teamInput, first_owner_email: 'invalid' }), 400, 'invalid_request');
    await rejected(await w.post(root, { ...teamInput, products: 'NOTES' }), 400, 'invalid_request');
    const { path, id } = await w.create();
    const other = await ensureUser(w.env, 'owner@example.com');
    db.prepare("UPDATE workspace_members SET user_id=? WHERE workspace_id=?").run(other.id, id);
    db.prepare("INSERT INTO workspace_members VALUES(?,?,'member',0,0)").run(id, w.admin);
    const refuse = async (action, input, status, code) => rejected(await w.post(path + '/' + action, input), status, code);
    await refuse('remove-member', { sub: other.id }, 409, 'last_owner');
    await refuse('role', { sub: other.id, role: 'viewer' }, 409, 'last_owner');
    await refuse('role', { sub: w.admin, role: 'owner' }, 403, 'access_denied');
    await refuse('invite', { email: 'new@example.com', role: 'owner' }, 403, 'access_denied');
    await refuse('role', { sub: w.admin, role: 'superuser' }, 400, 'invalid_request');
    await refuse('invite', { email: 'new@example.com', role: 'superuser' }, 400, 'invalid_request');
    await refuse('invite', { email: 'not-an-email', role: 'member' }, 400, 'invalid_request');
    await refuse('products', { add: 'notes', remove: 'notes' }, 400, 'invalid_request');
    await refuse('rename', { name: ' ' }, 400, 'invalid_request');
    db.prepare("INSERT INTO workspace_holds VALUES(?,'app','Balance due',0)").run(id);
    await refuse('close', {}, 409, 'workspace_held');
    assert.match(await (await w.get(path)).text(), /Balance due/);

    db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,personal_owner,created) VALUES('personal','default','personal','Solo',?,0)").run(other.id);
    db.prepare("INSERT INTO workspace_members VALUES('personal',?,'owner',0,0)").run(other.id);
    await rejected(await w.post(root + '/personal/invite', { email: 'new@example.com', role: 'member' }), 409, 'personal_workspace');
    assert.doesNotMatch(await (await w.get(root + '/personal')).text(), /Send invitation|Remove member/);
    const foreign = db.prepare('INSERT INTO realms(id,issuer,display_name,created) VALUES(?,?,?,0)');
    foreign.run('elsewhere', 'https://elsewhere.example', 'Elsewhere');
    db.exec("INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('foreign','elsewhere','team','Foreign team',0)");
    await rejected(await w.get(root + '/foreign'), 404, 'not_found');
    await rejected(await w.post(root + '/foreign/rename', { name: 'Refused' }), 404, 'not_found');
    assert.doesNotMatch(await (await w.get(root)).text(), /Foreign team/);
    assert.equal(db.prepare('SELECT version FROM workspaces WHERE id=?').get(id).version, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_invitations').get().n, 0);
    db.prepare('DELETE FROM workspace_holds WHERE workspace_id=?').run(id);
    assert.equal((await w.post(path + '/close')).status, 303);
    await refuse('rename', { name: 'Refused' }, 409, 'workspace_closed');
});

test('the status filter is preserved across 50-row pages and imported IDs remain reachable', async t => {
    const w = await setup(t);
    const insert = w.db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,status,created) VALUES(?,'default','team',?,?,0)");
    for (let i = 0; i < 51; i++) {
        const suffix = String(i).padStart(2, '0');
        insert.run('team-' + suffix, 'Team ' + suffix, 'active');
    }
    insert.run('new', 'Imported team', 'closed');
    w.db.exec("INSERT INTO audit(event,target,detail,created,realm_id) VALUES('admin_client_create','new','{}',0,'default')");
    const first = await (await w.get(root + '?status=active')).text();
    assertFireMarkup(first);
    assert.match(first, /Team 50/);
    assert.doesNotMatch(first, /Team 00|Imported team/);
    const nextUrl = first.match(/href="([^"]+)"[^>]*><span>Next page<\/span>/)[1].replaceAll('&amp;', '&');
    assert.equal(nextUrl, root + '?status=active&before=team-01');
    const next = await (await w.get(nextUrl)).text();
    assert.match(next, /Team 00/);
    assert.doesNotMatch(next, /Team 01|Imported team|Next page/);
    const closed = await (await w.get(root + '?status=closed')).text();
    assert.match(closed, /Imported team/);
    assert.doesNotMatch(closed, /Team 50/);
    const imported = await (await w.get(root + '/new')).text();
    assert.match(imported, /Imported team/);
    assert.doesNotMatch(imported, /admin_client_create/);
    await rejected(await w.get(root + '?status=unknown'), 400, 'invalid_request');
});

test('a different first owner gets an invitation and provider failure is disclosed after commit', async t => {
    const w = await setup(t), { db } = w;
    const { path, id } = await w.create({ ...teamInput, products: '', first_owner_email: 'FIRST@example.com' });
    const invitation = db.prepare('SELECT email,role FROM workspace_invitations WHERE workspace_id=?').get(id);
    assert.deepEqual({ ...invitation }, { email: 'first@example.com', role: 'owner' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_members WHERE workspace_id=?').get(id).n, 0);
    assert.equal(w.mails.at(-1).to, 'first@example.com');
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_products WHERE workspace_id=?').get(id).n, 0);
    w.env.EMAIL.send = async () => { throw new Error('Provider unavailable'); };
    const response = await w.post(path + '/invite', { email: 'another@example.com', role: 'member' }, { accept: 'text/html' });
    assert.equal(response.status, 503);
    const html = await response.text();
    assertFireMarkup(html);
    assert.match(html, /The invitation is saved/);
    assert.doesNotMatch(html, /Provider unavailable/);
    assert.match(await (await w.get(path)).text(), /another@example\.com/);
    assert.equal(db.prepare('SELECT version FROM workspaces WHERE id=?').get(id).version, 2);
});

test('the write batch rechecks the realm switch and the verified admin session', async t => {
    const w = await setup(t), { db } = w;
    const { path, id } = await w.create();
    const original = w.env.DB.batch.bind(w.env.DB);
    let beforeBatch = () => db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','off')");
    t.mock.method(w.env.DB, 'batch', async statements => {
        beforeBatch();
        return original(statements);
    });
    const rename = () => w.post(path + '/rename', { name: 'Refused' });
    await rejected(await rename(), 404, 'not_found');
    db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','on')");
    beforeBatch = () => db.exec('DELETE FROM mfa_factors');
    await rejected(await rename(), 409, 'conflict');
    assert.equal(db.prepare('SELECT version FROM workspaces WHERE id=?').get(id).version, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit WHERE target=?').get(id).n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_event_outbox WHERE workspace_id=?').get(id).n, 2);
});
