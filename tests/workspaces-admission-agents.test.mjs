import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, error, resource } from './support/agents.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';
import { accessEndStatements } from '../apps/server/src/workspaces/teardown.mjs';

const secondResource = 'https://app.example/w/team-two/mcp';
const workspaceName = 'Team <R&D> "North"';
async function setup(t, { member = true, open = false, registered = true } = {}) {
    const w = await agentWorld(t), db = w.env.DB.db;
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
        UPDATE clients SET workspaces='shared',product='notes',backchannel_uri='https://app.example/events' WHERE id='app';
        UPDATE clients SET workspaces='shared',product='files',backchannel_uri='https://other.example/events' WHERE id='other';`);
    db.prepare("UPDATE clients SET signup_policy=? WHERE id='app'").run(open ? 'open' : 'invited');
    addWorkspace(db, 'first', workspaceName, member ? w.user.id : null);
    if (registered) register(db, 'first', resource);
    return { ...w, db };
}
function addWorkspace(db, id, name, member) {
    db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES(?,'default','team',?,0)").run(id, name);
    db.prepare("INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,'notes',0)").run(id);
    if (member) db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES(?,?,'member',0,0)").run(id, member);
}
function register(db, id, address) {
    db.prepare("INSERT INTO workspace_resources(resource,workspace_id,client_id,created) VALUES(?,?,'app',0)").run(address, id);
}
const leave = (w, id, close = false) => w.env.DB.batch([
    ...accessEndStatements(w.env, id, w.user.id),
    close ? w.env.DB.prepare("UPDATE workspaces SET status='closed',closed_at=? WHERE id=?").bind(Date.now(), id)
        : w.env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').bind(id, w.user.id)
]);

test('registered-resource consent shows the escaped workspace name and lets a member approve', async t => {
    const w = await setup(t), flow = await w.start();
    const page = await w.call(`/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Team &lt;R&amp;D&gt; &quot;North&quot;/);
    assert.doesNotMatch(html, /<code[^>]*>team-one<\/code>|<script[^>]*\/fire\//);
    assert.equal((await w.approve(flow)).status, 303);
    assert.equal(w.db.prepare('SELECT resource FROM agent_grants').get().resource, resource);
});

test('registered-resource consent denies nonmembers even with an app admission on both GET and POST', async t => {
    const w = await setup(t, { member: false, open: true }), flow = await w.start();
    const page = await w.call(`/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie, 'accept-language': 'es' } });
    assert.equal(page.status, 403);
    assert.match(await page.text(), /Únete a este espacio de trabajo antes de conectar un agente/);
    await error(await w.approve(flow), 'access_denied', 403);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM agent_grants').get().n, 0);
    assert.equal(w.db.prepare('SELECT source FROM client_admissions').get().source, 'app');
});

test('a change in the resource’s app owner does not bypass workspace membership', async t => {
    const w = await setup(t, { member: false, open: true });
    w.db.exec(`UPDATE clients SET product='notes' WHERE id='other';
        UPDATE workspace_resources SET client_id='other';`);
    const flow = await w.start();
    await error(await w.approve(flow), 'access_denied', 403);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM agent_grants').get().n, 0);
});

test('approval fences membership removal at the grant transaction', async t => {
    const w = await setup(t, { open: true }), flow = await w.start();
    const batch = w.env.DB.batch;
    t.mock.method(w.env.DB, 'batch', statements => {
        // Shared sign-in records admission first. Race the later consent transaction.
        if (statements.length > 2) w.db.prepare('DELETE FROM workspace_members WHERE user_id=?').run(w.user.id);
        return batch(statements);
    });
    await error(await w.approve(flow), 'access_denied', 403);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM agent_grants').get().n, 0);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM agent_codes').get().n, 0);
    assert.ok(w.db.prepare('SELECT id FROM auth_requests WHERE id=?').get(flow.id));
});

for (const reason of ['realm switch off', 'closed registration', 'app workspaces']) test(`agent consent keeps app behavior for ${reason}`, async t => {
    const w = await setup(t, { member: false, open: true });
    if (reason === 'realm switch off') w.db.exec("UPDATE realms SET config=json_remove(config,'$.workspaces') WHERE id='default'");
    if (reason === 'closed registration') w.db.exec("UPDATE workspaces SET status='closed' WHERE id='first'");
    if (reason === 'app workspaces') w.db.exec("UPDATE clients SET workspaces='app' WHERE id='app'");
    const flow = await w.start();
    const page = await w.call(`/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<code[^>]*>team-one<\/code>/);
    assert.equal((await w.approve(flow)).status, 303);
});

test('teardown retains access through another workspace and only revokes matching live grants', async t => {
    const w = await setup(t);
    addWorkspace(w.db, 'second', 'Second', w.user.id);
    register(w.db, 'second', secondResource);
    const first = await w.grant(), secondFlow = await w.start({ resource: secondResource }), secondApproval = await w.approve(secondFlow);
    const secondCode = new URL(secondApproval.headers.get('location')).searchParams.get('code');
    const second = await w.exchange(secondCode, { resource: secondResource });
    assert.equal(second.status, 200);
    const secondTokens = await second.json();
    const otherUser = await ensureUser(w.env, 'other@example.com');
    const extraGrant = w.db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at,revoked_at)
        SELECT ?,client_id,client_name,registration_method,app_id,?,resource,scope,method,created,last_used,?,? FROM agent_grants WHERE user_id=? AND resource=? LIMIT 1`);
    extraGrant.run('expired', w.user.id, 1, null, w.user.id, resource);
    extraGrant.run('other-user', otherUser.id, Date.now() + 60_000, null, w.user.id, resource);
    extraGrant.run('revoked', w.user.id, Date.now() + 60_000, 1, w.user.id, resource);
    w.db.prepare("INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('app',?,'sid',?)").run(w.user.id, Date.now());
    await leave(w, 'first');
    assert.equal(w.db.prepare('SELECT source FROM client_admissions').get().source, 'workspace');
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM logout_outbox').get().n, 0);
    const revocations = w.db.prepare('SELECT user_id,resource,uri FROM agent_revocation_outbox').all();
    assert.deepEqual(revocations.map(Object.values), [[w.user.id, resource, 'https://app.example/events']]);
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM agent_grants WHERE revoked_at IS NOT NULL AND id IN ('expired','other-user','revoked')").get().n, 1);
    await error(await w.refresh(first.tokens.refresh_token), 'invalid_grant');
    assert.equal((await w.refresh(secondTokens.refresh_token, { resource: secondResource })).status, 200);
});

test('closing the last workspace scopes logout and admission deletion to participating product apps', async t => {
    const w = await setup(t);
    addWorkspace(w.db, 'closed-other', 'Already closed', w.user.id);
    w.db.exec("UPDATE workspaces SET status='closed' WHERE id='closed-other'");
    const addApp = w.db.prepare("INSERT INTO clients(id,redirect_uris,post_logout_uris,workspaces,product,backchannel_uri) VALUES(?,'[]','[]',?,'notes','https://apps.example/logout')");
    addApp.run('notes-console', 'shared'); addApp.run('notes-guest', 'shared'); addApp.run('notes-local', 'app');
    const addAdmission = w.db.prepare('INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,?,0,?)');
    const session = w.db.prepare('INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES(?,?,?,?)');
    for (const id of ['app', 'notes-console', 'notes-guest', 'notes-local', 'other']) {
        addAdmission.run(w.user.id, id, ['notes-guest', 'notes-local'].includes(id) ? 'app' : 'workspace');
        session.run(id, w.user.id, `sid-${id}`, Date.now());
    }
    const { tokens } = await w.grant();
    await leave(w, 'first', true);
    assert.deepEqual(w.db.prepare('SELECT client_id,source FROM client_admissions ORDER BY client_id').all().map(Object.values),
        [['notes-guest', 'app'], ['notes-local', 'app'], ['other', 'workspace']]);
    assert.deepEqual(w.db.prepare('SELECT client_id,user_id,sid FROM logout_outbox ORDER BY client_id').all().map(Object.values),
        ['app', 'notes-console', 'notes-guest'].map(id => [id, w.user.id, `sid-${id}`]));
    assert.deepEqual(w.db.prepare('SELECT client_id FROM app_sessions ORDER BY client_id').all().map(Object.values), [['notes-local'], ['other']]);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM agent_revocation_outbox').get().n, 1);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
});

for (const reason of ['removed member', 'realm switch off']) test(`refresh rejects a stale workspace admission for ${reason}`, async t => {
    const w = await setup(t, { registered: false });
    const { tokens } = await w.grant();
    if (reason === 'removed member') w.db.prepare('DELETE FROM workspace_members WHERE user_id=?').run(w.user.id);
    else w.db.exec("UPDATE realms SET config=json_remove(config,'$.workspaces') WHERE id='default'");
    assert.equal(w.db.prepare('SELECT source FROM client_admissions').get().source, 'workspace');
    assert.equal(w.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at, null);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
    assert.deepEqual(Object.values(w.db.prepare('SELECT spent_at,replacement_hash FROM agent_refresh_tokens WHERE hash=?').get(await sha256(tokens.refresh_token))), [null, null]);
});
