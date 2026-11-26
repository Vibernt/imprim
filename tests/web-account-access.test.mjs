import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { agentWorld } from './support/agents.mjs';
import { accountSession, change, checkBoundaries, problem, read } from './support/account-api.mjs';

const mutations = ['sessions', 'apps', 'devices', 'agents/revoke'];

test('account access routes require a session, header CSRF and same-origin mutations', async t => {
    const w = await world(t), { cookie } = await accountSession(w);
    await checkBoundaries(w, cookie, ['sessions', 'agents'], mutations);
    for (const path of mutations) await problem(await change(w, path, {}, cookie), 400, 'invalid_request');
    for (const query of ['before=junk', 'before=a&before=b']) await problem(await read(w, `agents?${query}`, cookie), 400, 'invalid_request');
});

test('only the owner can see or end a session, app session or remembered browser', async t => {
    const w = await world(t), owner = await accountSession(w), stranger = await accountSession(w, 'other@example.com');
    const extra = await accountSession(w), last = await accountSession(w), db = w.env.DB.db;
    const device = 'a'.repeat(64), expired = 'b'.repeat(64), now = Date.now();
    const insert = db.prepare('INSERT INTO trusted_devices(hash,user_id,client_id,name,created,last_used,expires_at) VALUES(?,?,?,?,?,?,?)');
    insert.run(device, owner.user.id, 'app', 'Browser to forget', now, now, now + 60000);
    insert.run(expired, owner.user.id, 'app', 'Expired browser', now - 60000, now, now - 1);
    db.prepare("INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('app',?,?,?)").run(owner.user.id, owner.session.sid, now);
    const list = async cookie => {
        const response = await read(w, 'sessions', cookie);
        assert.equal(response.status, 200);
        return response.json();
    };
    const access = await list(owner.cookie);
    assert.equal(access.sessions.find(session => session.current).sid, owner.session.sid);
    assert.deepEqual(access.apps.map(app => app.client_id), ['app']);
    assert.deepEqual(access.browsers.map(browser => browser.hash), [device]);
    const other = await list(stranger.cookie);
    assert.deepEqual(other.sessions.map(session => session.sid), [stranger.session.sid]);
    assert.deepEqual(other.apps, []);
    assert.deepEqual(other.browsers, []);
    await problem(await change(w, 'sessions', { sid: extra.session.sid }, stranger.cookie), 404, 'not_found');
    await problem(await change(w, 'apps', { client_id: 'app' }, stranger.cookie), 404, 'not_found');
    await problem(await change(w, 'devices', { device }, stranger.cookie), 404, 'not_found');
    assert.equal((await change(w, 'sessions', { sid: 'others' }, owner.cookie)).status, 200);
    assert.equal((await change(w, 'devices', { device }, owner.cookie)).status, 200);
    assert.equal((await change(w, 'apps', { client_id: 'app' }, owner.cookie)).status, 200);
    const updated = await list(owner.cookie);
    assert.deepEqual(updated.sessions.map(session => session.sid), [owner.session.sid]);
    assert.deepEqual(updated.apps, []);
    assert.deepEqual(updated.browsers, []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE sid IN (?,?)').get(extra.session.sid, last.session.sid).n, 0);
    assert.equal((await list(stranger.cookie)).sessions.length, 1);
    await w.drain();
});

test('JSON agent revocation ends the grant and queues the same notice as the account form', async t => {
    const w = await agentWorld(t);
    await w.grant();
    const db = w.env.DB.db, grant = db.prepare('SELECT id FROM agent_grants').get();
    const stranger = await accountSession(w, 'other@example.com');
    await problem(await change(w, 'agents/revoke', { grant_id: grant.id }, stranger.cookie), 403, 'access_denied');
    db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    assert.equal((await change(w, 'agents/revoke', { grant_id: grant.id }, w.cookie)).status, 200);
    const { agents } = await (await read(w, 'agents', w.cookie)).json();
    assert.equal(agents[0].status, 'revoked');
    assert.equal(agents[0].name, 'Example Agent');
    assert.deepEqual(agents[0].scopes, [{ code: 'read', label: 'Read workspace' }]);
    assert.ok(db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    await w.drain();
    assert.equal(w.events.length, 1);
});

test('retained account forms still check CSRF and return to the sessions and apps screen', async t => {
    const w = await world(t), owner = await accountSession(w), other = await accountSession(w), db = w.env.DB.db;
    const csrf = owner.cookie.match(/__Host-vi_csrf=([^;]+)/)[1], device = 'c'.repeat(64), now = Date.now();
    db.prepare("INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('app',?,?,?)").run(owner.user.id, owner.session.sid, now);
    db.prepare("INSERT INTO trusted_devices(hash,user_id,client_id,name,created,last_used,expires_at) VALUES(?,?,'app','Test',?,?,?)")
        .run(device, owner.user.id, now, now, now + 60000);
    for (const [path, body, notice] of [
        ['sessions', { sid: other.session.sid }, 'session'], ['apps', { client_id: 'app' }, 'app'], ['devices', { device }, 'browser']
    ]) {
        const post = fields => w.call(`/account/${path}`, { method: 'POST', body: new URLSearchParams(fields),
            headers: { origin: w.env.ISSUER, cookie: owner.cookie } });
        await problem(await post(body), 403, 'csrf');
        const result = await post({ ...body, csrf });
        assert.equal(result.status, 303);
        assert.equal(result.headers.get('location'), `${w.env.ISSUER}/account/sessions?changed=${notice}`);
    }
    await w.drain();
});
