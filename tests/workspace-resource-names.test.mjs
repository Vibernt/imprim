import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, error, resource } from './support/agents.mjs';
import { basic } from './support/world.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';

const path = '/v1/workspaces/named/resources';
async function setup(t) {
    const w = await agentWorld(t), db = w.env.DB.db;
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
        UPDATE clients SET workspaces='shared',product='notes',agent_resource_prefixes='["https://app.example/"]' WHERE id='app';
        UPDATE clients SET workspaces='shared',product='tasks' WHERE id='other';
        INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('named','default','team','Workspace',0);
        INSERT INTO workspace_products(workspace_id,product,created) VALUES('named','notes',0),('named','tasks',0);`);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('named',?,'member',0,0)").run(w.user.id);
    const put = (name, { app = 'app', address = resource } = {}) => w.call(path, { method: 'PUT',
        headers: { authorization: basic(app), 'content-type': 'application/json' }, body: JSON.stringify({ resource: address, name }) });
    const saved = () => db.prepare('SELECT name FROM workspace_resources WHERE resource=?').get(resource)?.name;
    const audit = () => db.prepare("SELECT detail FROM audit WHERE event='workspace_resource_named' ORDER BY id").all().map(row => JSON.parse(row.detail));
    const account = async () => {
        const response = await w.call('/v1/account/agents', { headers: { cookie: w.cookie } });
        assert.equal(response.status, 200, await response.clone().text());
        return (await response.json()).agents;
    };
    return { ...w, db, put, saved, audit, account };
}

async function snapshot(response) {
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
}

test('resource names trim, update and clear, and re-registering an unchanged value writes nothing', async t => {
    const w = await setup(t);
    const first = await snapshot(await w.put('  Workspace tools  '));
    assert.equal(w.saved(), 'Workspace tools');
    const changes = () => w.db.prepare('SELECT total_changes() AS n').get().n;
    const unchanged = changes();
    for (const name of [null, undefined, ' Workspace tools ']) {
        assert.deepEqual(await snapshot(await w.put(name)), first);
        assert.equal(changes(), unchanged);
    }
    const next = await snapshot(await w.put('🌿'.repeat(80)));
    assert.equal(next.version, first.version + 1);
    assert.equal(w.saved(), '🌿'.repeat(80));
    const cleared = await snapshot(await w.put(''));
    assert.equal(cleared.version, next.version + 1);
    assert.equal(w.saved(), null);
    assert.deepEqual(await snapshot(await w.put('')), cleared);
    assert.deepEqual(w.audit(), Array.from({ length: 3 }, () => ({ workspace_id: 'named', resource })));
});

test('resource names refuse control characters, oversized text, non-strings and whitespace-only values', async t => {
    const w = await setup(t);
    await snapshot(await w.put('Original'));
    for (const invalid of ['x'.repeat(81), '🌿'.repeat(81), 'invalid\tname', 'name\u0085', '\nname', 'name\u0000', '  ', {}, 17])
        await error(await w.put(invalid), 'invalid_request', 400);
    assert.equal(w.saved(), 'Original');
    assert.equal(w.audit().length, 1);
});

test('a different app with the same prefix and workspace access cannot rename a registration', async t => {
    const w = await setup(t);
    await snapshot(await w.put('Original'));
    w.db.exec("UPDATE clients SET agent_resource_prefixes='[\"https://app.example/\"]' WHERE id='other'");
    await error(await w.put('Other app', { app: 'other' }), 'resource_registered', 409);
    assert.equal(w.saved(), 'Original');
    assert.equal(w.audit().length, 1);
});

test('a workspace-choice URL cannot be registered as a workspace resource', async t => {
    const w = await setup(t), address = 'https://app.example/mcp';
    w.db.prepare("UPDATE clients SET agent_workspace_resources=? WHERE id='app'").run(JSON.stringify([address]));
    await error(await w.put('Conflicting name', { address }), 'resource_registered', 409);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM workspace_resources').get().n, 0);
    assert.deepEqual(w.audit(), []);
});

test('consent escapes the resource name above the URL and account reads current names', async t => {
    const w = await setup(t);
    await snapshot(await w.put('A <tool> & more'));
    const flow = await w.start();
    const consent = await w.call('/agent/consent?request_id=' + flow.id, { headers: { cookie: flow.cookie } });
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /Resource<\/dt>.*A &lt;tool&gt; &amp; more<br><code class="fd-code">https:\/\/app\.example\/w\/team-one\/mcp<\/code>/);
    await w.grant();
    const [agent] = await w.account();
    assert.equal(agent.resource_name, 'A <tool> & more');
    assert.equal(agent.workspace_id, null);
    await snapshot(await w.put('Renamed tools'));
    assert.equal((await w.account())[0].resource_name, 'Renamed tools');
    await snapshot(await w.put(''));
    assert.equal((await w.account())[0].resource_name, null);
});

test('the SDK sends the optional name and can clear it over the app API', async t => {
    const w = await setup(t);
    const identity = createClient({ issuer: w.env.ISSUER, clientId: 'app', clientSecret: 'secret',
        fetch: (url, init) => w.call(new URL(url).pathname, init) });
    const registered = await identity.registerWorkspaceResource('named', resource, { name: 'SDK tools' });
    assert.equal(w.saved(), 'SDK tools');
    assert.deepEqual(await identity.registerWorkspaceResource('named', resource), registered);
    await identity.registerWorkspaceResource('named', resource, { name: '' });
    assert.equal(w.saved(), null);
});
