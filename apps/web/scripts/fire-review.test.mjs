// Fire's screenshot gate (fire review) over every Lit screen, signed in, against the real Worker on a loopback origin.
// Writes the gallery to apps/web/.fire-review/index.html and fails on any review error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeServer } from './smoke-server.mjs';
import { approvalPath, seedMachineWorkspace, seededRequest } from '../../../tests/support/workspace-machines.mjs';
import { forgetRealms } from '../../server/src/realms/realm.mjs';
import { seedSignupRequest } from './signup-fixture.mjs';

test('fire review: every Lit screen at 1440 and 375, light and dark', { timeout: 600000 }, async t => {
    const { parseArgs, review } = await import(new URL('../node_modules/fire-design/scripts/review.mjs', import.meta.url).href);
    const server = await smokeServer(t, 'platform');
    const db = server.env.DB.db, now = Date.now();
    db.prepare("UPDATE realms SET config=json_set(config,'$.workspaces','on')").run();
    db.prepare("INSERT OR IGNORE INTO workspaces(id,realm_id,kind,name,version,created) VALUES('ws_review','default','team','Acme team',3,?)").run(now);
    db.prepare("INSERT OR IGNORE INTO workspace_products(workspace_id,product,created) VALUES('ws_review','notes',?)").run(now);
    seedSignupRequest(db);
    const user = db.prepare('SELECT id FROM users ORDER BY created LIMIT 1').get();
    seedMachineWorkspace(db, user.id);
    forgetRealms(server.env);
    const { request_id } = await seededRequest(server);
    db.prepare(`INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,source,
        workspace_id,accountable_user_id,expires_at,created,updated)
        VALUES('ws-11111111111111111111','default','app','Editorial bot','admin@app.example','{"keys":[]}','["read"]',
        '["https://app.example/mcp"]','workspace','ws_test',?,?,?,?)`).run(user.id, now + 86400000, now, now);
    const client = db.prepare('SELECT id FROM clients ORDER BY id LIMIT 1').get();
    const routes = [
        ['/account', 'account'], ['/account/security', 'account-security'], ['/account/sessions', 'account-sessions'],
        ['/account/agents', 'account-agents'], [approvalPath(request_id), 'machine-approval'], ['/admin/clients', 'clients'], ['/admin/clients/new', 'client-new'],
        ['/admin/clients/' + client.id, 'client-edit'], ['/admin/services', 'services'], ['/admin/users', 'users'],
        ['/admin/users/' + user.id, 'user-detail'], ['/admin/audit', 'audit'], ['/admin/signups', 'signups'], ['/admin/workspaces', 'workspaces'],
        ['/admin/workspaces/ws_review', 'workspace-detail'], ['/admin/branding', 'branding'], ['/admin/settings', 'settings'],
        ['/admin/keys', 'keys'], ['/admin/realms', 'realms']
    ].map(([path, name]) => ({ path, name }));
    const o = parseArgs(['--base', server.origin, '--routes', routes.map(r => r.path).join(',')]);
    Object.assign(o, { routes, out: '.fire-review', setup: { cookie: server.cookies.map(c => `${c.name}=${c.value}`) } });
    const result = await review(o);
    for (const f of result.findings) console.log(`${f.severity} ${f.rule} ${f.route} ${f.width} ${f.theme}: ${f.message}`);
    console.log(`fire review: ${result.screens} screens, ${result.errors} errors, ${result.warnings} warnings -> ${result.out}`);
    assert.equal(result.errors, 0, 'fire review errors');
});
