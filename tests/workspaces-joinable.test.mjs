import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../packages/imprim-client/index.mjs';
import { signJwt } from '../apps/server/src/oidc/jwt.mjs';
import { dispatchDeliveries } from '../apps/server/src/services/outbox.mjs';
import { error } from './support/agents.mjs';
import { response, root, setup } from './support/workspaces.mjs';
import { basic } from './support/world.mjs';

const path = root + '/joinable';
const list = (w, actor_token, auth = basic('other')) => w.api('POST', path, { actor_token }, auth);
const enableTasksAdmin = w => w.db.exec("UPDATE clients SET workspace_admin='on' WHERE id='other'");

function seedTeam(w, owner, id, name, { realm = 'default', status = 'active', products = ['notes'], via = null } = {}) {
    w.db.prepare(`INSERT INTO workspaces(id,realm_id,kind,name,status,created,created_via)
        VALUES(?,?,'team',?,?,0,?)`).run(id, realm, name, status, via);
    w.addMember(id, owner, 'owner');
    const addProduct = w.db.prepare('INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,?,0)');
    for (const product of products) addProduct.run(id, product);
}

test('joinable workspaces list only active team workspaces the actor owns in this realm without the app product', async t => {
    const w = await setup(t);
    enableTasksAdmin(w);
    const realmAdmin = await w.actor('admin@example.com', 'other');
    const adminAsNotes = await w.actor(realmAdmin.email);
    const otherOwner = await w.actor('other-owner@example.com');
    w.db.exec("INSERT INTO realms(id,issuer,display_name,config,created) VALUES('second','https://second.example','Second','{}',0)");
    seedTeam(w, realmAdmin, 'owned-z', 'Alpha', { products: ['notes', 'files'], via: 'signup' });
    seedTeam(w, realmAdmin, 'owned-a', 'Alpha');
    seedTeam(w, realmAdmin, 'owned-b', 'Beta');
    seedTeam(w, realmAdmin, 'already-added', 'Already added', { products: ['notes', 'tasks'] });
    seedTeam(w, realmAdmin, 'closed', 'Closed', { status: 'closed' });
    // A cross-realm membership row must not expose the workspace even when its owner id matches.
    seedTeam(w, realmAdmin, 'foreign', 'Foreign', { realm: 'second' });
    for (const role of ['admin', 'member', 'viewer']) {
        seedTeam(w, otherOwner, role, role);
        w.addMember(role, realmAdmin, role);
    }
    seedTeam(w, otherOwner, 'unrelated', 'Unrelated');
    await response(await w.api('POST', root, {
        kind: 'personal', name: 'Personal', actor_token: adminAsNotes.actor_token
    }), 201);

    const auditCount = () => w.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    const before = auditCount();
    const result = await list(w, realmAdmin.actor_token);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response(result), { workspaces: [
        { workspace_id: 'owned-a', name: 'Alpha', kind: 'team', created_via: null, products: ['notes'], version: 1 },
        { workspace_id: 'owned-z', name: 'Alpha', kind: 'team', created_via: 'signup', products: ['files', 'notes'], version: 1 },
        { workspace_id: 'owned-b', name: 'Beta', kind: 'team', created_via: null, products: ['notes'], version: 1 }
    ] });
    assert.equal(auditCount(), before);
});

test('joinable workspaces returns at most 100 rows in order without a cursor', async t => {
    const w = await setup(t);
    enableTasksAdmin(w);
    const owner = await w.actor('owner@example.com', 'other');
    const ids = Array.from({ length: 101 }, (_, index) => 'team-' + String(index).padStart(3, '0'));
    for (const id of ids.toReversed()) seedTeam(w, owner, id, 'Team');
    const data = await response(await list(w, owner.actor_token));
    assert.deepEqual(Object.keys(data), ['workspaces']);
    assert.deepEqual(data.workspaces.map(workspace => workspace.workspace_id), ids.slice(0, 100));
});

test('joinable workspaces authenticates the client and verifies its actor and live session', async t => {
    const w = await setup(t);
    enableTasksAdmin(w);
    const owner = await w.actor('owner@example.com', 'other');
    const wrongApp = await w.actor(owner.email);
    seedTeam(w, owner, 'owned', 'Owned');

    await error(await list(w, owner.actor_token, basic('other', 'bad')), 'invalid_client', 401);
    for (const token of [undefined, 'garbage']) await error(await list(w, token), 'invalid_request', 400);
    assert.deepEqual(await response(await list(w, wrongApp.actor_token), 400), {
        error: 'invalid_request', error_description: 'Actor token was issued to another app.'
    });

    const now = Math.floor(Date.now() / 1000);
    const expired = await signJwt(w.env, {
        iss: w.env.ISSUER, aud: 'other', azp: 'other', sub: owner.id, sid: owner.session.sid, iat: now - 900, exp: now - 300
    });
    assert.equal((await response(await list(w, expired))).workspaces.length, 1);
    w.db.prepare('UPDATE sessions SET expires_at=0 WHERE sid=?').run(owner.session.sid);
    await error(await list(w, owner.actor_token), 'invalid_request', 400);
    w.db.prepare('DELETE FROM sessions WHERE sid=?').run(owner.session.sid);
    await error(await list(w, owner.actor_token), 'invalid_request', 400);
});

test('joinable workspaces requires current app administration and workspace participation', async t => {
    const w = await setup(t);
    enableTasksAdmin(w);
    const owner = await w.actor('owner@example.com', 'other');
    const actorToken = owner.actor_token;
    const gatedOff = { error: 'not_found', error_description: 'Workspace API is not available.' };

    const limit = t.mock.method(w.env.API_LIMITER, 'limit', async () => {
        // Change the flag after client authentication reads it.
        w.db.exec("UPDATE clients SET workspace_admin='off' WHERE id='other'");
        return { success: true };
    });
    const flagError = await response(await list(w, actorToken), 403);
    limit.mock.restore();
    assert.deepEqual(flagError, { error: 'access_denied', error_description: 'App is not enabled for this workspace operation.' });
    seedTeam(w, owner, 'using-tasks', 'Using tasks', { products: ['tasks'] });
    const write = await w.api('POST', root + '/using-tasks/products', { add: ['tasks'], remove: [], actor_token: actorToken }, basic('other'));
    assert.deepEqual(await response(write, 403), flagError);

    enableTasksAdmin(w);
    w.db.exec("UPDATE clients SET workspaces='app' WHERE id='other'");
    assert.deepEqual(await response(await list(w, actorToken), 404), gatedOff);
    w.db.exec("UPDATE clients SET workspaces='shared',product=NULL WHERE id='other'");
    assert.deepEqual(await response(await list(w, actorToken), 404), gatedOff);
    w.db.exec("UPDATE clients SET product='tasks' WHERE id='other'");
    w.db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','off') WHERE id='default'");
    assert.deepEqual(await response(await list(w, actorToken), 404), gatedOff);
});

test('GET at the joinable path still looks up a single workspace by id', async t => {
    const w = await setup(t);
    enableTasksAdmin(w);
    const owner = await w.actor('owner@example.com', 'other');
    seedTeam(w, owner, 'owned', 'Owned');
    const get = () => w.api('GET', path, undefined, basic('other'));
    assert.deepEqual(await response(await get(), 404), { error: 'not_found', error_description: 'Workspace not found.' });
    seedTeam(w, owner, 'joinable', 'Imported', { products: ['tasks'] });
    assert.deepEqual(await response(await get()), {
        workspace_id: 'joinable', name: 'Imported', kind: 'team', created_via: null, status: 'active', products: ['tasks'], version: 1
    });
    assert.deepEqual((await response(await list(w, owner.actor_token))).workspaces.map(row => row.workspace_id), ['owned']);
});

test('a listed workspace joins the app product, moves to memberships and queues events for both apps', async t => {
    const w = await setup(t);
    enableTasksAdmin(w);
    const notesOwner = await w.actor('owner@example.com');
    const tasksOwner = await w.actor(notesOwner.email, 'other');
    const actor = { actorToken: tasksOwner.actor_token };
    const { workspace_id, status, ...summary } = await w.team(notesOwner);
    const tasks = createClient({ issuer: w.env.ISSUER, clientId: 'other', clientSecret: 'secret', fetch: (url, init) => {
        const target = new URL(url);
        assert.equal(target.origin, w.env.ISSUER);
        return w.call(target.pathname + target.search, init);
    } });
    assert.deepEqual(await tasks.memberships(tasksOwner.id), { memberships: [] });
    const { workspaces } = await tasks.joinableWorkspaces(actor);
    assert.deepEqual(workspaces, [{ workspace_id, ...summary }]);
    const products = ['notes', 'tasks'], version = 2;
    const changed = await tasks.setWorkspaceProducts(workspaces[0].workspace_id, { ...actor, add: ['tasks'], remove: [] });
    assert.deepEqual(changed, { workspace_id, ...summary, status, products, version });
    assert.deepEqual(await tasks.memberships(tasksOwner.id), {
        memberships: [{ workspace_id, ...summary, products, version, role: 'owner' }]
    });
    assert.deepEqual(await tasks.joinableWorkspaces(actor), { workspaces: [] });

    const queued = [];
    w.env.LOGOUT_QUEUE = { async send(message) { queued.push(message); } };
    await dispatchDeliveries(w.env);
    const events = w.db.prepare(`SELECT id,client_id,payload,queued_at FROM workspace_event_outbox
        WHERE workspace_id=? AND event='workspace-products-changed' ORDER BY client_id`).all(workspace_id);
    assert.deepEqual(events.map(event => event.client_id), ['app', 'other']);
    for (const event of events) {
        assert.deepEqual(JSON.parse(event.payload), { workspace_id, version, products });
        assert.ok(event.queued_at > 0);
        assert.ok(queued.some(message => message.type === 'workspace_event' && message.event_id === event.id));
    }
});
