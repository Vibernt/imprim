import test from 'node:test';
import assert from 'node:assert/strict';
import { error } from './support/agents.mjs';
import { response, root, setup } from './support/workspaces.mjs';
import { basic } from './support/world.mjs';

const products = (w, id, body) => w.api('POST', `${root}/${id}/products`, body, basic('other'));

function seed(w, owner) {
    w.db.exec("UPDATE clients SET workspace_admin='on' WHERE id='other'");
    w.db.exec("INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('team','default','team','Team',0)");
    w.db.exec("INSERT INTO workspace_products(workspace_id,product,created) VALUES('team','notes',0)");
    w.addMember('team', owner, 'owner');
}

test('an omitted add or remove list counts as empty when an app changes its own product', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com', 'other');
    seed(w, owner);
    const added = await response(await products(w, 'team', { add: ['tasks'], actor_token: owner.actor_token }));
    assert.deepEqual(added.products, ['notes', 'tasks']);
    const removed = await response(await products(w, 'team', { remove: ['tasks'], actor_token: owner.actor_token }));
    assert.deepEqual(removed.products, ['notes']);
});

test('present lists must still be arrays of the app product', async t => {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com', 'other');
    seed(w, owner);
    for (const body of [{ add: 'tasks' }, { add: ['tasks'], remove: 'notes' }, { add: ['notes'] }, { add: [42] }])
        await error(await products(w, 'team', { ...body, actor_token: owner.actor_token }), 'invalid_request', 400);
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM workspace_products WHERE workspace_id='team'").get().n, 1);
});
