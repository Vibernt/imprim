import assert from 'node:assert/strict';
import test from 'node:test';
import { error } from './support/agents.mjs';
import { addTeam, jarOf, joinWorld } from './support/workspace-join.mjs';
import { begin } from './support/world.mjs';

async function setup(t) {
    const w = await joinWorld(t);
    w.db.exec("UPDATE admins SET role='realm' WHERE email='admin@example.com'");
    const owner = await w.person('admin@example.com');
    addTeam(w.db, 'team', owner.user.id);
    const flow = await w.offer(owner);
    return { ...w, owner, flow };
}

test('the hosted decision requires issuer Origin, CSRF, its browser, and the bound account', async t => {
    const w = await setup(t), { flow, owner } = w;
    await error(await w.answer(flow, {}, { origin: 'https://evil.example' }), 'origin', 403);
    await error(await w.answer(flow, {}, { origin: '' }), 'origin', 403);
    await error(await w.form('/workspace-join', { action: 'join', request_id: flow.id, workspace_id: 'team' }, flow.cookie), 'csrf', 403);
    await error(await w.answer(flow, { csrf: 'wrong-token' }), 'csrf', 403);
    await error(await w.answer(flow, {}, { cookie: owner.cookie }), 'browser_binding', 403);
    const other = await w.person('other-owner@example.com');
    addTeam(w.db, 'other-team', other.user.id);
    const differentUser = { cookie: jarOf(other.cookie, flow.browser), csrf: other.csrf, id: flow.id };
    await error(await w.answer(differentUser, { workspace_id: 'other-team' }), 'access_denied', 403);
    await error(await w.answer(differentUser, { action: 'decline' }), 'access_denied', 403);
    await error(await w.call(flow.path, { headers: { cookie: differentUser.cookie } }), 'access_denied', 403);
    await error(await w.call(flow.path, { headers: { cookie: flow.browser } }), 'login_required', 401);
    assert.equal(w.productCount(), 0);
});

test('the hosted decision requires a live offer and a workspace from its choice list', async t => {
    const w = await setup(t), { flow, owner } = w;
    addTeam(w.db, 'non-joinable', owner.user.id, { kind: 'personal' });
    for (const id of ['unknown', 'non-joinable', '']) await error(await w.answer(flow, { workspace_id: id }), 'not_found', 404);
    await error(await w.answer(flow, { action: 'other' }), 'invalid_request', 400);
    const neverOffered = await begin(w, '', { client_id: 'other' });
    await error(await w.answer({ ...flow, id: neverOffered.request_id, cookie: jarOf(owner.cookie, neverOffered.cookie) }),
        'access_denied', 403);
    w.db.prepare('UPDATE auth_requests SET expires_at=0 WHERE id=?').run(flow.id);
    await error(await w.answer(flow), 'browser_binding', 403);
    assert.equal(w.productCount(), 0);
});

test('Not now consumes the request, returns the usual OAuth refusal and adds nothing', async t => {
    const w = await setup(t), { flow } = w;
    const resp = await w.answer(flow, { action: 'decline', workspace_id: '' });
    assert.equal(resp.status, 303);
    const target = new URL(resp.headers.get('location'));
    assert.equal(target.origin + target.pathname, 'https://app.example/callback');
    assert.deepEqual(Object.fromEntries(target.searchParams), { error: 'access_denied', state: 'rp-state', iss: w.env.ISSUER });
    assert.equal(w.db.prepare('SELECT id FROM auth_requests WHERE id=?').get(flow.id), undefined);
    assert.equal(w.productCount(), 0);
    await error(await w.answer(flow), 'browser_binding', 403);
});

test('ownership and workspace status are rechecked even when the acting owner is a realm admin', async t => {
    const w = await setup(t), { flow, owner } = w;
    assert.equal((await w.call(flow.path, { headers: { cookie: flow.cookie } })).status, 200);
    const secondOwner = await w.person('second-owner@example.com');
    w.db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('team',?,'owner',0,0)").run(secondOwner.user.id);
    w.db.prepare("DELETE FROM workspace_members WHERE workspace_id='team' AND user_id=?").run(owner.user.id);
    await error(await w.answer(flow), 'not_found', 404);
    const empty = await (await w.call(flow.path, { headers: { cookie: flow.cookie } })).text();
    assert.match(empty, /No workspaces are available/);
    assert.doesNotMatch(empty, /name="workspace_id"|value="join"/);
    // With nothing to choose, the one button says where it goes.
    assert.match(empty, /value="decline"[^>]*><span class="fd-truncate">Back to /);
    const next = await w.offer(secondOwner);
    w.db.exec("UPDATE workspaces SET status='closed' WHERE id='team'");
    assert.ok([404, 409].includes((await w.answer(next)).status));
    assert.equal(w.productCount(), 0);
});

for (const [label, change] of [
    ['ownership', w => w.db.exec("UPDATE workspace_members SET role='admin' WHERE workspace_id='team'")],
    ['client flag', w => w.db.exec("UPDATE clients SET join_workspaces='off' WHERE id='other'")],
    ['client redirect', w => w.db.exec(`UPDATE clients SET redirect_uris='["https://other.example/callback"]' WHERE id='other'`)],
    ['sign-in methods', w => w.db.exec(`UPDATE clients SET sign_in_methods='["passkey"]' WHERE id='other'`)],
    ['request expiry', w => w.db.prepare('UPDATE auth_requests SET expires_at=0 WHERE id=?').run(w.flow.id)],
    ['session revocation', w => w.db.prepare('DELETE FROM sessions WHERE hash=?').run(w.owner.session.hash)],
    ['promotion to platform admin', w => w.db.exec("UPDATE admins SET role='platform' WHERE email='admin@example.com'")]
]) test(`the hosted write fences a concurrent change to ${label}`, async t => {
    const w = await setup(t), batch = w.env.DB.batch;
    t.mock.method(w.env.DB, 'batch', statements => { change(w); return batch(statements); });
    const rejected = await w.answer(w.flow);
    assert.ok(rejected.status >= 400 && rejected.status < 500, await rejected.clone().text());
    assert.equal(w.productCount(), 0);
    assert.equal(w.db.prepare("SELECT version FROM workspaces WHERE id='team'").get().version, 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_event_outbox').get().n, 0);
});

test('a platform administrator cannot accept an already issued workspace join offer', async t => {
    const w = await setup(t);
    w.db.exec("UPDATE admins SET role='platform' WHERE email='admin@example.com'");
    const refused = await w.answer(w.flow);
    assert.equal(refused.status, 200);
    assert.match(await refused.text(), /This address manages Vibernt/);
    assert.equal(w.productCount(), 0);
    assert.equal(w.db.prepare("SELECT version FROM workspaces WHERE id='team'").get().version, 1);
});

test('simultaneous joins for one request can add at most one of its offered workspaces', async t => {
    const w = await joinWorld(t), owner = await w.person();
    addTeam(w.db, 'team', owner.user.id);
    addTeam(w.db, 'second', owner.user.id);
    const flow = await w.offer(owner);
    const answers = await Promise.all([w.answer(flow), w.answer(flow, { workspace_id: 'second' })]);
    const ok = answers.filter(res => res.status === 303), refused = answers.filter(res => res.status >= 400 && res.status < 500);
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(new URL(ok[0].headers.get('location')).searchParams.get('code'));
    assert.equal(w.productCount(), 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM codes').get().n, 1);
});

test('a product added after the offer resumes authorization without a duplicate version, audit or events', async t => {
    const w = await setup(t), { flow } = w;
    assert.equal((await w.call(flow.path, { headers: { cookie: flow.cookie } })).status, 200);
    const batch = w.env.DB.batch;
    const race = t.mock.method(w.env.DB, 'batch', statements => {
        w.db.exec("INSERT INTO workspace_products(workspace_id,product,created) VALUES('team','tasks',0); UPDATE workspaces SET version=2 WHERE id='team'");
        race.mock.restore();
        return batch(statements);
    });
    const joined = await w.answer(flow);
    assert.equal(joined.status, 303, await joined.clone().text());
    assert.ok(new URL(joined.headers.get('location')).searchParams.get('code'));
    assert.equal(w.productCount(), 1);
    assert.equal(w.db.prepare("SELECT version FROM workspaces WHERE id='team'").get().version, 2);
    for (const table of ['audit', 'workspace_event_outbox'])
        assert.equal(w.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE event='workspace-products-changed'`).get().n, 0);
});
