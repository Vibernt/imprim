import test from 'node:test';
import assert from 'node:assert/strict';
import { error } from './support/agents.mjs';
import { response, root, setup } from './support/workspaces.mjs';
import { basic } from './support/world.mjs';

async function heldTeam(t) {
    const w = await setup(t);
    const owner = await w.actor('owner@example.com');
    const { workspace_id } = await w.team(owner);
    await w.addTasks(owner, workspace_id);
    const path = root + '/' + workspace_id;
    const hold = (reason, auth) => w.api('PUT', path + '/holds', { reason }, auth);
    const close = (body, auth) => w.api('POST', path + '/close', { actor_token: owner.actor_token, ...body }, auth);
    const holds = () => w.db.prepare('SELECT client_id,reason FROM workspace_holds WHERE workspace_id=? ORDER BY client_id').all(workspace_id)
        .map(row => [row.client_id, row.reason]);
    const status = () => w.db.prepare('SELECT status FROM workspaces WHERE id=?').get(workspace_id).status;
    return { w, owner, workspace_id, hold, close, holds, status };
}

test('release_own_hold lets the calling app close past its own hold and removes it only with the close', async t => {
    const { hold, close, holds, status, w, workspace_id } = await heldTeam(t);
    await response(await hold('Unbilled usage'));
    await error(await close({}), 'workspace_held', 409);
    await error(await close({ release_own_hold: false }), 'workspace_held', 409);
    assert.deepEqual(holds(), [['app', 'Unbilled usage']]);
    const closed = await response(await close({ release_own_hold: true }));
    assert.equal(closed.status, 'closed');
    assert.equal(status(), 'closed');
    assert.deepEqual(holds(), []);
    const audit = JSON.parse(w.db.prepare("SELECT detail FROM audit WHERE event='workspace-closed' AND target=?").get(workspace_id).detail);
    assert.equal(audit.released_own_hold, true);
});

test('another app hold still blocks, and a refused close keeps the caller hold', async t => {
    const { hold, close, holds, status } = await heldTeam(t);
    await response(await hold('Unbilled usage'));
    await response(await hold('Incomplete export', basic('other')));
    const blocked = await close({ release_own_hold: true });
    const body = await blocked.clone().json();
    await error(blocked, 'workspace_held', 409);
    assert.match(body.error_description, /Incomplete export/);
    assert.ok(!body.error_description.includes('Unbilled usage'));
    assert.deepEqual(holds(), [['app', 'Unbilled usage'], ['other', 'Incomplete export']]);
    await error(await close({ release_own_hold: true, confirm: 'Wrong name' }), 'workspace_held', 409);
    assert.equal(status(), 'active');
});

test('a refused close for another reason keeps the hold, and the option must be a boolean', async t => {
    const { hold, close, holds, status } = await heldTeam(t);
    await response(await hold('Unbilled usage'));
    await error(await close({ release_own_hold: true, confirm: 'Wrong name' }), 'invalid_request', 400);
    await error(await close({ release_own_hold: 'yes' }), 'invalid_request', 400);
    await error(await close({ release_own_hold: true, actor_token: 'not-a-token' }), 'invalid_request', 400);
    assert.deepEqual(holds(), [['app', 'Unbilled usage']]);
    assert.equal(status(), 'active');
});
