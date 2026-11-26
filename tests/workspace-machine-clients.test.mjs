import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/server/src/worker.mjs';
import { forgetRealms } from '../apps/server/src/realms/realm.mjs';
import { thumbprint } from '../apps/server/src/machines/dpop.mjs';
import { signAgentJwt } from '../apps/server/src/agents/grants.mjs';
import { sealTotp } from '../apps/server/src/auth/mfa.mjs';
import { currentStep, fromBase32, totpAt } from '../apps/server/src/auth/totp.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';
import { basic, turnstile } from './support/world.mjs';
import { dpopKey } from './support/machine-keys.mjs';
import { adminLogin } from './support/admin.mjs';
import { change, checkBoundaries, csrf, problem, read } from './support/account-api.mjs';
import { response } from './support/workspaces.mjs';
import { approvalPath, choice, form, machineWorld, resource } from './support/workspace-machines.mjs';

const wrongApp = basic('other');
const update = (w, sql, ...args) => w.db.prepare(sql).run(...args);
const statusPath = id => '/requests/' + id;

test('machine requests require a confidential participating app, enabled agent access and its own exact permissions', async t => {
    const w = await machineWorld(t);
    await problem(await w.api('POST', '', w.payload, 'Basic bad'), 401, 'invalid_client');
    await problem(await w.api('POST', '', w.payload, wrongApp), 404, 'not_found');
    w.db.exec("UPDATE clients SET workspaces='shared',product='tasks' WHERE id='other'");
    await problem(await w.api('POST', '', w.payload, wrongApp), 404, 'not_found');
    w.db.exec("UPDATE clients SET agent_access='off' WHERE id='app'");
    await problem(await w.api('POST', '', w.payload), 403, 'access_denied');
    w.db.exec("UPDATE clients SET agent_access='on' WHERE id='app'");
    const key = w.pair.jwk;
    for (const invalid of [
        { name: ' ' }, { jwks: { keys: [{ ...key, d: 'private' }] } }, { jwks: { keys: [{ ...key, qi: '' }] } },
        { jwks: { keys: Array.from({ length: 6 }, (_, i) => ({ ...key, kid: String(i) })) } },
        { jwks: { keys: [key, key] } }, { scopes: ['absent'] }, { scopes: ['read', 'read'] }, { scopes: [] },
        { resources: [resource, resource] }, { resources: [] }
    ]) await problem(await w.api('POST', '', { ...w.payload, ...invalid }), 400, 'invalid_request');
    w.db.exec(`INSERT INTO workspace_resources(resource,workspace_id,client_id,created)
        VALUES('https://app.example/elsewhere','ws_other','app',0),('https://app.example/other-app','ws_test','other',0)`);
    for (const target of ['https://app.example/unregistered', 'https://app.example/elsewhere', 'https://app.example/other-app', resource + '/child'])
        await problem(await w.api('POST', '', { ...w.payload, resources: [target] }), 400, 'invalid_target');
    assert.deepEqual(w.audit('machine_client_requested'), []);
    const receipt = await w.create();
    assert.match(receipt.request_id, /^[0-9a-f]{32}$/);
    assert.equal(receipt.approval_url, w.env.ISSUER + approvalPath(receipt.request_id));
    const created = w.db.prepare('SELECT * FROM machine_client_requests').get();
    assert.equal(receipt.expires_at - created.created, 86400000);
    assert.deepEqual(await w.status(receipt.request_id), { request_id: receipt.request_id, status: 'pending', expires_at: receipt.expires_at });
    w.db.exec("UPDATE clients SET product='notes' WHERE id='other'");
    await problem(await w.api('GET', statusPath(receipt.request_id), undefined, wrongApp), 404, 'not_found');
    update(w, 'UPDATE machine_client_requests SET expires_at=0 WHERE id=?', receipt.request_id);
    assert.equal((await w.status(receipt.request_id)).status, 'expired');
    assert.equal(w.audit('machine_client_requested').length, 1);
});

test('machine APIs use the authenticated app API limiter and enforce both workspace caps atomically', async t => {
    const w = await machineWorld(t);
    const calls = [];
    const limiter = t.mock.method(w.env.API_LIMITER, 'limit', async input => { calls.push(input); return { success: false }; });
    await problem(await w.api('POST', '', w.payload), 429, 'rate_limit');
    assert.equal(calls.length, 1);
    limiter.mock.restore();
    for (let i = 0; i < 9; i++) await w.create();
    const requests = await Promise.all([w.api('POST', '', w.payload), w.api('POST', '', w.payload)]);
    assert.deepEqual(requests.map(r => r.status).sort(), [201, 409]);
    await problem(requests.find(r => r.status === 409), 409, 'limit_reached');
    const [first, second] = w.db.prepare('SELECT id FROM machine_client_requests ORDER BY rowid LIMIT 2').all();
    w.fillMachines(19);
    const answers = await Promise.all([w.submit(first.id), w.submit(second.id)]);
    assert.deepEqual(answers.map(r => r.status).sort(), [200, 400]);
    await problem(answers.find(r => r.status === 400), 400, 'invalid_request');
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM service_clients').get().n, 20);
    assert.equal(w.audit('machine_client_approved').length, 1);
    w.db.exec("UPDATE machine_client_requests SET expires_at=0 WHERE status='pending'");
    await problem(await w.api('POST', '', w.payload), 409, 'limit_reached');
});

test('approval lists the requested permissions and keys, enforces session, realm, role, CSRF and Origin, and emails once', async t => {
    const w = await machineWorld(t);
    const { request_id: id } = await w.create({ name: 'Editorial <bot>' });
    const signedOut = await w.view(id, { cookie: '' });
    assert.equal(signedOut.status, 401);
    assert.match(await signedOut.text(), /Sign in to see your account.*https:\/\/app\.example\/sign-in/s);
    for (const role of ['member', 'viewer']) {
        const person = await w.addPerson(role);
        assert.equal((await w.view(id, person)).status, 403);
        await problem(await w.submit(id, person), 403, 'access_denied');
    }
    w.db.exec("INSERT INTO realms(id,issuer,display_name,created) VALUES('foreign','https://foreign.example','Foreign',0)");
    forgetRealms(w.env);
    const foreign = await worker.fetch(new Request('https://foreign.example' + approvalPath(id), { headers: { accept: 'text/html', cookie: w.owner.cookie } }), w.env, { waitUntil() {} });
    assert.equal(foreign.status, 401);
    assert.doesNotMatch(await foreign.text(), /Editorial|app\.example\/sign-in/);
    update(w, "UPDATE machine_client_requests SET realm_id='foreign' WHERE id=?", id);
    const wrongRealm = await w.view(id);
    assert.equal(wrongRealm.status, 400);
    update(w, "UPDATE machine_client_requests SET realm_id='default' WHERE id=?", id);
    const page = await w.view(id);
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const text of ['Allow a machine to act for Editorial team?', 'Example App', 'Editorial tools', '<span class="fd-mono-sm">' + resource,
        choice, 'Editorial &lt;bot&gt;', 'Read workspace', 'ES256', await thumbprint(w.pair.jwk),
        'Works until ', 'You stay accountable for it', 'action="/machine-client"', 'value="approve"', 'value="deny"']) assert.ok(html.includes(text), text);
    assert.match(html, /Signed in as .*You stay accountable for it/s);
    assert.match(html, /<details class="fd-disclosure"><summary[^>]+>.*Technical details.*https:\/\/app\.example/s);
    assert.match(html, /Allow Editorial &lt;bot&gt;/);
    assert.doesNotMatch(html, /action="\/switch-account"|style=|<script[^>]*src="\/fire\//);
    await problem(await w.submit(id, w.owner, { fields: { csrf: '' } }), 403, 'csrf');
    const crossOrigin = await w.submit(id, w.owner, { headers: { origin: 'https://other.example', accept: 'text/html' } });
    assert.equal(crossOrigin.status, 403);
    assert.match(crossOrigin.headers.get('content-type'), /text\/html/);
    const result = await w.submit(id);
    assert.equal(result.status, 200, await result.clone().text());
    assert.match(await result.text(), /Machine allowed\..*href="https:\/\/app\.example\/sign-in"/s);
    await problem(await w.submit(id), 400, 'invalid_request');
    assert.equal((await w.view(id)).status, 400);
    const { service_client_id: clientId } = await w.status(id);
    const approved = w.db.prepare('SELECT * FROM service_clients WHERE id=?').get(clientId);
    assert.deepEqual([approved.source, approved.workspace_id, approved.accountable_user_id, approved.owner_email, approved.expires_at - approved.created],
        ['workspace', 'ws_test', w.owner.user.id, w.owner.user.email, 90 * 86400000]);
    assert.deepEqual(JSON.parse(w.audit('machine_client_approved')[0].detail),
        { request_id: id, workspace_id: 'ws_test', app_id: 'app', client_id: clientId });
    await w.drain();
    assert.equal(w.mails.length, 1);
    assert.equal(w.mails[0].to, w.owner.user.email);
    assert.match(w.mails[0].text, /Editorial <bot>.*Example App.*Editorial team.*read/s);
    assert.match(w.mails[0].html, /Editorial &lt;bot&gt;/);
});

test('an expired or denied request stays unusable, even if someone submits its approval directly', async t => {
    const w = await machineWorld(t);
    const expired = (await w.create()).request_id;
    update(w, 'UPDATE machine_client_requests SET expires_at=0 WHERE id=?', expired);
    assert.equal((await w.view(expired)).status, 400);
    await problem(await w.submit(expired), 400, 'invalid_request');
    const denied = (await w.create()).request_id;
    const result = await w.submit(denied, w.owner, { decision: 'deny' });
    assert.equal(result.status, 200);
    assert.match(await result.text(), /Request denied\./);
    assert.equal((await w.status(denied)).status, 'denied');
    assert.equal((await w.view(denied)).status, 400);
    await problem(await w.submit(denied), 400, 'invalid_request');
    assert.equal(w.audit('machine_client_denied').length, 1);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM service_clients').get().n, 0);
});

test('parallel approval POSTs mint one client and a role downgrade before or during the write grants nothing', async t => {
    const w = await machineWorld(t);
    const admin = await w.addPerson('admin');
    const { request_id: first } = await w.create();
    const answers = await Promise.all([w.submit(first, admin), w.submit(first, admin)]);
    assert.deepEqual(answers.map(r => r.status).sort(), [200, 400]);
    assert.equal(w.audit('machine_client_approved').length, 1);
    const { request_id: second } = await w.create();
    assert.equal((await w.view(second, admin)).status, 200);
    const demote = () => update(w, "UPDATE workspace_members SET role='member' WHERE user_id=?", admin.user.id);
    demote();
    await problem(await w.submit(second, admin), 403, 'access_denied');
    update(w, "UPDATE workspace_members SET role='admin' WHERE user_id=?", admin.user.id);
    const batch = w.env.DB.batch.bind(w.env.DB);
    const hook = t.mock.method(w.env.DB, 'batch', statements => {
        demote();
        return batch(statements);
    });
    await problem(await w.submit(second, admin), 400, 'invalid_request');
    hook.mock.restore();
    assert.equal((await w.status(second)).status, 'pending');
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM service_clients').get().n, 1);
});

test('the agent consent MFA rule gates both approval methods and resumes through a narrowly scoped return URL', async t => {
    const w = await machineWorld(t);
    w.db.exec("UPDATE clients SET agent_consent_mfa='required' WHERE id='app'");
    const { request_id: id } = await w.create();
    const enroll = await w.view(id);
    assert.equal(enroll.status, 303);
    assert.equal(new URL(enroll.headers.get('location')).pathname, '/account/mfa');
    const secret = 'JBSWY3DPEHPK3PXP', factor = 'test-factor';
    update(w, `INSERT INTO mfa_factors(id,user_id,type,name,sealed_secret,confirmed,created)
        VALUES(?,?,'totp','Test authenticator',?,1,0)`, factor, w.owner.user.id, await sealTotp(w.env, factor, secret));
    const need = await w.submit(id);
    assert.equal(need.status, 303);
    const challenge = new URL(need.headers.get('location'));
    assert.equal(challenge.pathname, '/mfa');
    assert.equal(challenge.searchParams.get('next'), approvalPath(id));
    assert.equal((await w.status(id)).status, 'pending');
    const verified = await form(w, '/mfa', { next: approvalPath(id), csrf: csrf(w.owner.cookie),
        code: await totpAt(fromBase32(secret), currentStep()) }, { cookie: w.owner.cookie });
    assert.equal(verified.status, 303);
    assert.equal(verified.headers.get('location'), w.env.ISSUER + approvalPath(id));
    assert.equal((await w.view(id)).status, 200);
    assert.equal((await w.submit(id)).status, 200);
});

test('machine tokens retain private-key authentication, exactly scoped resources, accountability and 60-second expiry', async t => {
    const w = await machineWorld(t);
    const id = await w.approve();
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', fetch: (url, init) => w.call(new URL(url).pathname, init) });
    await problem(await form(w, '/token', { grant_type: 'client_credentials', client_id: id, resource }), 401, 'invalid_client');
    await problem(await w.token(id, 'https://app.example/no'), 400, 'invalid_target');
    await problem(await w.token(id, resource + '/child'), 400, 'invalid_target');
    for (const target of [resource, choice]) {
        const { access_token, expires_in } = await response(await w.token(id, target));
        assert.equal(expires_in, 60);
        const verified = await client.verifyAccessToken(access_token, { audience: target });
        assert.equal(verified.sub, 'service:' + id);
        assert.equal(verified.grant_id, verified.sub);
        assert.equal(verified.accountable_sub, 'legacy:editor');
        assert.equal(verified.workspace_id, 'ws_test');
        assert.equal(verified.exp - verified.iat, 60);
        assert.deepEqual(await w.introspect(access_token, 'other'), { active: false });
        const live = await w.introspect(access_token);
        assert.deepEqual([live.active, live.workspace_id, live.accountable_sub], [true, 'ws_test', 'legacy:editor']);
        const bad = await signAgentJwt(w.env, { ...verified, accountable_sub: 42 });
        await assert.rejects(client.verifyAccessToken(bad, { audience: target }), { code: 'invalid_token' });
    }
    update(w, `INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,created,updated)
        VALUES('admin-machine','default','app','Admin machine','admin@app.example',?,'["read"]',?,0,0)`,
        JSON.stringify(w.payload.jwks), JSON.stringify([resource]));
    const target = resource + '/child';
    const { access_token } = await response(await w.token('admin-machine', target));
    const claims = await client.verifyAccessToken(access_token, { audience: target });
    assert.equal(Object.hasOwn(claims, 'workspace_id'), false);
    assert.equal(Object.hasOwn(claims, 'accountable_sub'), false);
    assert.equal((await w.introspect(access_token)).active, true);
});

test('workspace machines retain DPoP proof binding and reject replay', async t => {
    const w = await machineWorld(t), id = await w.approve(), key = await dpopKey();
    const dpop = await key.proof();
    const { access_token, token_type } = await response(await w.token(id, resource, { dpop }));
    assert.equal(token_type, 'DPoP');
    await problem(await w.token(id, resource, { dpop }), 400, 'invalid_dpop_proof');
    const active = await w.introspect(access_token);
    assert.deepEqual([active.active, active.cnf.jkt, active.accountable_sub], [true, key.jkt, w.owner.user.id]);
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', fetch: (url, init) => w.call(new URL(url).pathname, init) });
    const bound = { proof: await key.proof({ htm: 'GET', htu: resource, accessToken: access_token }), method: 'GET', url: resource };
    await assert.rejects(client.verifyAccessToken(access_token, { audience: resource }), { code: 'invalid_dpop_proof' });
    const verified = await client.verifyAccessToken(access_token, { audience: resource, dpop: bound });
    assert.deepEqual([verified.workspace_id, verified.accountable_sub], ['ws_test', w.owner.user.id]);
});

for (const [label, sql, args] of [
    ['client expires', 'UPDATE service_clients SET expires_at=0', []],
    ['accountable person leaves', 'DELETE FROM workspace_members WHERE user_id=?', ['legacy:editor']],
    ['accountable person is demoted', "UPDATE workspace_members SET role='member' WHERE user_id=?", ['legacy:editor']],
    ['accountable person is blocked', "UPDATE users SET status='blocked' WHERE id=?", ['legacy:editor']],
    ['accountable person is merged', "UPDATE users SET merged_into=(SELECT id FROM users WHERE email='admin@app.example') WHERE id=?", ['legacy:editor']],
    ['workspace closes', "UPDATE workspaces SET status='closed' WHERE id='ws_test'", []],
    ['product is removed', "DELETE FROM workspace_products WHERE workspace_id='ws_test'", []],
    ['client is disabled', "UPDATE service_clients SET status='disabled'", []],
    ['resource is reassigned', "UPDATE workspace_resources SET workspace_id='ws_other' WHERE resource=?", [resource]],
]) test(`workspace machine issuance and introspection stop when the ${label}`, async t => {
    const w = await machineWorld(t), id = await w.approve();
    if (label === 'accountable person is merged') await w.addPerson('admin');
    const { access_token } = await response(await w.token(id));
    assert.equal((await w.introspect(access_token)).active, true);
    update(w, sql, ...args);
    assert.deepEqual(await w.introspect(access_token), { active: false });
    const reassigned = label === 'resource is reassigned';
    await problem(await w.token(id), reassigned ? 400 : 401, reassigned ? 'invalid_target' : 'invalid_client');
});

test('the workspace app can list and disable its machines with an admin or accountable actor token', async t => {
    const w = await machineWorld(t), first = await w.approve(), second = await w.approve();
    const admin = await w.addPerson('admin'), member = await w.addPerson('member');
    const { machine_clients } = await response(await w.api('GET'));
    assert.equal(machine_clients.length, 2);
    const item = machine_clients.find(row => row.client_id === first);
    assert.deepEqual([item.name, item.scopes, item.resources, item.accountable_sub, item.status, item.last_used],
        ['Editorial bot', ['read'], [resource, choice], w.owner.user.id, 'active', null]);
    assert.equal(item.expires_at - item.created, 90 * 86400000);
    const disable = async (id, person) => w.api('DELETE', '/' + id, { actor_token: await w.actor(person) });
    await problem(await disable(first, member), 403, 'access_denied');
    await problem(await w.api('DELETE', '/' + first, { actor_token: await w.actor(admin, 'other') }), 400, 'invalid_request');
    assert.deepEqual(await response(await disable(first, admin)), { client_id: first, disabled: true });
    update(w, "UPDATE workspace_members SET role='member' WHERE user_id=?", w.owner.user.id);
    assert.deepEqual(await response(await disable(second, w.owner)), { client_id: second, disabled: true });
    assert.equal((await response(await w.api('GET'))).machine_clients.every(machine => machine.status === 'disabled'), true);
    assert.equal(w.audit('machine_client_disabled').length, 2);
    w.db.exec("UPDATE clients SET workspaces='shared',product='notes' WHERE id='other'");
    assert.deepEqual(await response(await w.api('GET', '', undefined, wrongApp)), { machine_clients: [] });
});

test('account machines are private and can be renewed only while live, or disabled by their accountable person', async t => {
    const w = await machineWorld(t), id = await w.approve();
    const other = await w.addPerson('admin'), ownerCookie = w.owner.cookie;
    const renew = 'machine-clients/renew', disable = 'machine-clients/disable', body = { client_id: id };
    await checkBoundaries(w, ownerCookie, ['agents'], [renew, disable]);
    assert.deepEqual((await response(await read(w, 'agents', other.cookie))).machine_clients, []);
    const [machine] = (await response(await read(w, 'agents', ownerCookie))).machine_clients;
    assert.deepEqual([machine.client_id, machine.app, machine.workspace, machine.status], [id, 'Example App', 'Editorial team', 'active']);
    for (const action of [renew, disable]) {
        const missing = await change(w, action, {}, other.cookie);
        const hidden = await change(w, action, body, other.cookie);
        assert.equal(missing.status, 404);
        assert.equal(hidden.status, 404);
        assert.deepEqual(await hidden.json(), await missing.json());
    }
    w.db.exec("UPDATE clients SET agent_max_grant_days=2 WHERE id='app'");
    await response(await change(w, renew, body, ownerCookie));
    const renewed = w.db.prepare('SELECT expires_at,updated FROM service_clients WHERE id=?').get(id);
    assert.equal(renewed.expires_at - renewed.updated, 2 * 86400000);
    update(w, "UPDATE workspace_members SET role='member' WHERE user_id=?", w.owner.user.id);
    await problem(await change(w, renew, body, ownerCookie), 400, 'invalid_request');
    await response(await change(w, disable, body, ownerCookie));
    await problem(await change(w, renew, body, ownerCookie), 400, 'invalid_request');
    assert.equal((await response(await read(w, 'agents', ownerCookie))).machine_clients[0].status, 'disabled');
    assert.deepEqual([w.audit('machine_client_renewed').length, w.audit('machine_client_disabled').length], [1, 1]);
});

test('realm administrators see workspace client details and can only disable the client', async t => {
    const w = await machineWorld(t), id = await w.approve();
    turnstile(t);
    const admin = await adminLogin(w);
    const [machine] = (await response(await admin.get('services'))).services;
    assert.deepEqual([machine.source, machine.workspace_name, machine.accountable_sub, machine.accountable_email],
        ['workspace', 'Editorial team', 'legacy:editor', 'owner@app.example']);
    assert.ok(machine.expires_at > Date.now());
    for (const body of [{ name: 'Edited' }, { status: 'active' }, { status: 'disabled', scopes: ['write'] }])
        await problem(await admin.post('services/' + id, body), 400, 'invalid_request');
    await problem(await admin.post('services/' + id + '/delete'), 400, 'invalid_request');
    const result = await response(await admin.post('services/' + id, { status: 'disabled' }));
    assert.equal(result.service.status, 'disabled');
});

test('the client package uses the workspace machine endpoints and actor token through the real Worker', async t => {
    const w = await machineWorld(t);
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', clientSecret: 'secret',
        fetch: (url, init) => { const target = new URL(url); return w.call(target.pathname + target.search, init); } });
    const { request_id } = await client.requestMachineClient('ws_test', w.payload);
    assert.equal((await client.machineClientRequest('ws_test', request_id)).status, 'pending');
    assert.equal((await w.submit(request_id)).status, 200);
    const { service_client_id } = await client.machineClientRequest('ws_test', request_id);
    assert.equal((await client.machineClients('ws_test')).machine_clients[0].client_id, service_client_id);
    await assert.rejects(client.disableMachineClient('ws_test', service_client_id), { code: 'configuration' });
    assert.deepEqual(await client.disableMachineClient('ws_test', service_client_id, { actorToken: await w.actor() }),
        { client_id: service_client_id, disabled: true });
});
