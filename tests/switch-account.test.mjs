import assert from 'node:assert/strict';
import test from 'node:test';
import { error } from './support/agents.mjs';
import { begin } from './support/world.mjs';
import { addTeam, jarOf, joinWorld } from './support/workspace-join.mjs';

test('Not you signs the session out, queues back-channel logout and keeps the browser-bound sign-in request', async t => {
    const w = await joinWorld(t), owner = await w.person();
    addTeam(w.db, 'team', owner.user.id);
    const flow = await w.offer(owner);
    w.db.prepare("INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('app',?,?,?)").run(owner.user.id, owner.session.sid, Date.now());
    const fields = { request_id: flow.id, csrf: owner.csrf };
    const post = (body = fields, cookie = flow.cookie, headers = {}) => w.form('/switch-account', body, cookie, headers);
    const foreign = await begin(w);
    assert.equal((await w.call(`/switch-account?request_id=${flow.id}`, { headers: { cookie: flow.cookie } })).status, 404);
    await error(await post(fields, flow.browser), 'login_required', 401);
    await error(await post({ request_id: flow.id }), 'csrf', 403);
    await error(await post({ ...fields, csrf: 'wrong' }), 'csrf', 403);
    await error(await post(fields, jarOf(owner.cookie, foreign.cookie)), 'browser_binding', 403);
    await error(await post(fields, flow.cookie, { origin: 'https://other.example.com' }), 'origin', 403);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM logout_outbox').get().n, 0);
    assert.ok(w.db.prepare('SELECT workspace_join FROM auth_requests WHERE id=?').get(flow.id).workspace_join);

    const switched = await post();
    assert.equal(switched.status, 303, await switched.clone().text());
    assert.equal(switched.headers.get('location'), `/login?request_id=${flow.id}`);
    assert.deepEqual(switched.headers.getSetCookie().map(value => value.split(';')[0]), ['__Host-vi_session=', '__Host-vi_csrf=']);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.ok(w.db.prepare("SELECT 1 FROM logout_outbox WHERE client_id='app' AND sid=?").get(owner.session.sid));
    assert.equal(w.db.prepare('SELECT workspace_join FROM auth_requests WHERE id=?').get(flow.id).workspace_join, null);
    const signedOut = await w.call(switched.headers.get('location'), { headers: { cookie: flow.browser } });
    assert.equal(signedOut.status, 200);
    assert.match(await signedOut.text(), new RegExp(`data-request-id="${flow.id}"`));
    await error(await post(), 'login_required', 401);
    await w.drain();
});

test('switch-account preserves a completed join’s account fence', async t => {
    const w = await joinWorld(t), owner = await w.person();
    addTeam(w.db, 'team', owner.user.id);
    const flow = await w.offer(owner);
    w.db.prepare("UPDATE auth_requests SET workspace_join=json_remove(workspace_join,'$.product','$.workspace_ids') WHERE id=?").run(flow.id);
    const response = await w.form('/switch-account', { request_id: flow.id, csrf: owner.csrf }, flow.cookie);
    assert.equal(response.status, 303);
    assert.deepEqual(JSON.parse(w.db.prepare('SELECT workspace_join FROM auth_requests WHERE id=?').get(flow.id).workspace_join), { user_id: owner.user.id });
});
