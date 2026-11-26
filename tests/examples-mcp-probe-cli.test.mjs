import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './support/agent-workspace-choice.mjs';
import { machineWorld } from './support/workspace-machines.mjs';
import { d1Database } from './support/sqlite.mjs';
import probe from '../examples/mcp-probe/src/worker.mjs';

const origin = 'https://probe.example.com';
const product = `${origin}/mcp`;
const workspace = `${origin}/w/team-one/mcp`;

function cli(t, w) {
    w.env.DB.db.prepare(`UPDATE clients SET agent_resource_prefixes=?,agent_workspace_resources=?,agent_scope_catalogue=? WHERE id='app'`)
        .run(JSON.stringify([`${origin}/w/`, product]), JSON.stringify([product]), JSON.stringify({ 'probe.read': 'Read the probe' }));
    const DB = d1Database(new URL('../examples/mcp-probe/migrations/', import.meta.url));
    t.after(() => DB.db.close());
    const issuer = w.env.ISSUER;
    const issuerCall = (url, init) => w.call(url.pathname + url.search, init);
    const env = { ORIGIN: origin, ISSUER: issuer, CLIENT_ID: 'app', PRODUCT_RESOURCE: 'on', WORKSPACES: 'team-one', APP_SECRET: 'secret', DB,
        IDENTITY_FETCH: (url, init) => issuerCall(new URL(url), init) };
    const dir = mkdtempSync(join(tmpdir(), 'imprim-probe-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'app-secret');
    writeFileSync(path, 'secret', { mode: 0o600 });
    const logs = [], assertions = [];
    t.mock.method(console, 'log', line => logs.push(String(line)));
    t.mock.method(console, 'error', line => logs.push(String(line)));
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = new URL(input);
        if (url.origin === origin) return probe.fetch(new Request(url, init), env);
        if (url.origin !== issuer) throw Error('Unexpected request origin');
        if (url.pathname === '/token') assertions.push(init.body.get('client_assertion'));
        if (url.pathname.includes('/machine-clients/requests/')) {
            const id = url.pathname.split('/').at(-1);
            assert.equal((await w.view(id)).status, 200);
            assert.equal((await w.submit(id)).status, 200);
        }
        return issuerCall(url, init);
    });
    async function run(...args) {
        const argv = process.argv, code = process.exitCode;
        process.argv = [process.execPath, 'agent/run.mjs', ...args, '--app-id', 'app', '--app-secret-file', path];
        try {
            await import(`../examples/mcp-probe/agent/run.mjs?${args[0]}`);
            return process.exitCode;
        } finally {
            process.argv = argv;
            process.exitCode = code;
        }
    }
    return { run, logs, assertions };
}

test('the name command registers a name and verifies repeating it is a no-op', async t => {
    const w = await setup(t);
    w.addWorkspace('chosen');
    const { run, logs } = cli(t, w);
    assert.equal(await run('name', 'chosen', workspace, '--name', 'Team tools'), 0);
    assert.equal(w.db.prepare('SELECT name FROM workspace_resources WHERE resource=?').get(workspace)?.name, 'Team tools');
    assert.equal(w.db.prepare("SELECT count(*) AS n FROM audit WHERE event='workspace_resource_named'").get().n, 1);
    assert.ok(logs.includes('PASS  registering the same name leaves the workspace unchanged'));
});

test('the machine command uses its default product URL and checks issuance, audience, whoami and introspection', async t => {
    const w = await machineWorld(t);
    const { run, logs, assertions } = cli(t, w);
    assert.equal(await run('machine', 'ws_test'), 0);
    const request = w.db.prepare('SELECT * FROM machine_client_requests').get();
    assert.equal(request.name, 'Imprim probe worker');
    assert.deepEqual(JSON.parse(request.scopes), ['probe.read']);
    assert.deepEqual(JSON.parse(request.resources), [product]);
    assert.ok(logs.some(line => line.includes(`${w.env.ISSUER}/machine-client?request_id=`)));
    assert.ok(logs.includes('PASS  the machine token lives at most 60 seconds: 60 s'));
    assert.ok(logs.includes('PASS  whoami identifies the machine and its accountable person'));
    assert.ok(logs.includes('PASS  the machine cannot request a token for a workspace endpoint'));
    assert.ok(logs.includes('PASS  introspection reports the machine token active'));
    assert.ok(logs.some(line => line.includes(`${w.env.ISSUER}/account/agents`)));
    assert.equal(assertions.length, 2);
    assert.ok(assertions[0] !== assertions[1]);
    assert.ok(assertions.every(assertion => assertion && logs.every(line => !line.includes(assertion))));
});
