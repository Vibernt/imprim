// Fire's screenshot gate (fire review) over every Lit screen, signed in, against the real Worker on a loopback origin.
// Writes the gallery to apps/web/.fire-review/index.html and fails on any review error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeServer } from './smoke-server.mjs';
import { approvalPath, seedMachineWorkspace, seededRequest } from '../../../tests/support/workspace-machines.mjs';
import { forgetRealms } from '../../server/src/realms/realm.mjs';
import { seedAccountWorkspaceMember } from '../../../tests/support/account-workspaces.mjs';
import { seedSignupRequest } from './signup-fixture.mjs';
import { reviewRowConfirmations, seedRowConfirmReview } from './review-row-confirm.mjs';

test('fire review: every Lit screen at 1440 and 375, light and dark', { timeout: 600000 }, async t => {
    const { gallery, parseArgs, review } = await import(new URL('../node_modules/fire-design/scripts/review.mjs', import.meta.url).href);
    const server = await smokeServer(t, 'platform');
    const db = server.env.DB.db, now = Date.now();
    db.prepare("UPDATE realms SET config=json_set(config,'$.workspaces','on')").run();
    db.prepare("INSERT OR IGNORE INTO workspaces(id,realm_id,kind,name,version,created) VALUES('ws_review','default','team','Acme team',3,?)").run(now);
    db.prepare("INSERT OR IGNORE INTO workspace_products(workspace_id,product,created) VALUES('ws_review','notes',?)").run(now);
    db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('ws_review_held','default','team','Northwind team',?)").run(now);
    db.prepare("INSERT INTO workspace_holds(workspace_id,client_id,reason,created) VALUES('ws_review_held','app','Outstanding invoice',?)").run(now);
    db.prepare("INSERT INTO workspace_resources(resource,workspace_id,client_id,created) VALUES('https://app.example/w/northwind/mcp','ws_review_held','app',?)").run(now);
    seedSignupRequest(db);
    db.prepare(`INSERT INTO client_drafts(id,realm_id,configuration) VALUES('draft-notes','default',?)`).run(JSON.stringify({
        branding: { name: 'Draft notes' }, redirect_uris: ['https://notes.example.com/callback'], sign_in_methods: ['email'],
    }));
    const user = db.prepare('SELECT id FROM users ORDER BY created LIMIT 1').get();
    seedAccountWorkspaceMember(db, 'ws_review', user.id, 'owner', now);
    db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,?)').run('review-member', 'teammate@example.com', now);
    seedAccountWorkspaceMember(db, 'ws_review', 'review-member', 'member', now);
    db.prepare("UPDATE clients SET initiate_login_uri='https://notes.example.com/sign-in' WHERE id='app'").run();
    db.prepare(`INSERT INTO workspace_invitations(id,workspace_id,email,role,created,expires_at)
        VALUES('review-invite','ws_review','invited@example.com','viewer',?,?)`).run(now, now + 86400000);
    seedRowConfirmReview(db, user.id, now);
    seedMachineWorkspace(db, user.id);
    forgetRealms(server.env);
    const { request_id } = await seededRequest(server);
    db.prepare(`INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,source,
        workspace_id,accountable_user_id,expires_at,created,updated)
        VALUES('ws-11111111111111111111','default','app','Editorial bot','admin@app.example','{"keys":[]}','["read"]',
        '["https://app.example/mcp"]','workspace','ws_test',?,?,?,?)`).run(user.id, now + 86400000, now, now);
    const client = db.prepare('SELECT id FROM clients ORDER BY id LIMIT 1').get();
    const routes = [
        ['/account', 'account'], ['/account/apps', 'account-apps'], ['/account/security', 'account-security'], ['/account/sessions', 'account-sessions'],
        ['/account/agents', 'account-agents'], ['/account/workspaces', 'account-workspaces'],
        ['/account/workspaces/ws_review', 'account-workspace-detail'], [approvalPath(request_id), 'machine-approval'], ['/admin/clients', 'clients'], ['/admin/clients/new', 'client-new'],
        ['/admin/clients/' + client.id, 'client-edit'], ['/admin/clients/draft-notes', 'client-draft'], ['/admin/services', 'services'], ['/admin/users', 'users'],
        ['/admin/users/' + user.id, 'user-detail'], ['/admin/audit', 'audit'], ['/admin/signups', 'signups'], ['/admin/workspaces', 'workspaces'],
        ['/admin/workspaces?create=1', 'workspace-new'], ['/admin/workspaces/ws_review', 'workspace-detail'],
        ['/admin/workspaces/ws_review_held', 'workspace-detail-held'], ['/admin/workspaces/ws_review/close', 'workspace-close'],
        ['/admin/branding', 'branding'], ['/admin/settings', 'configuration'],
        ['/admin/keys', 'keys'], ['/admin/realms', 'realms'], ['/admin/realms?create=1', 'realm-new'], ['/admin/realms?realm=default', 'realm-edit']
    ].map(([path, name]) => ({ path, name }));
    const o = parseArgs(['--base', server.origin, '--routes', routes.map(r => r.path).join(',')]);
    Object.assign(o, { routes, out: '.fire-review', setup: { cookie: server.cookies.map(c => `${c.name}=${c.value}`) } });
    const result = await review(o);
    for (const f of result.findings) console.log(`${f.severity} ${f.rule} ${f.route} ${f.width} ${f.theme}: ${f.message}`);
    console.log(`fire review: ${result.screens} screens, ${result.errors} errors, ${result.warnings} warnings -> ${result.out}`);
    assert.equal(result.errors, 0, 'fire review errors');
    await reviewRowConfirmations(server, o, gallery);
});
