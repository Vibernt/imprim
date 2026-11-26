import test from 'node:test';
import assert from 'node:assert/strict';
import { error, metadataId, resource as ordinaryResource } from './support/agents.mjs';
import { adminLogin, assertFireMarkup, clientConfig } from './support/admin.mjs';
import { basic, cookieJar, world } from './support/world.mjs';
import { signAgentJwt } from '../apps/server/src/agents/grants.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';

import { resource, target, deviceGrant, accessTokenType, claims, consentPath, setup } from './support/agent-workspace-choice.mjs';

const offered = html => [...html.matchAll(/name="workspace_id" value="([^"]+)"( checked)? required/g)]
    .map(([, id, checked]) => [id, Boolean(checked)]);
const count = (w, table) => w.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const refresh = (w, tokens) => w.refresh(tokens.refresh_token, { resource });
const revocations = (w, id) => w.db.prepare('SELECT reason FROM agent_revocation_outbox WHERE grant_id=?').all(id).map(row => row.reason);

test('client settings require a shared, agent-enabled app and up to five canonical URLs under its prefixes', async t => {
    const w = await world(t);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' }));
    const admin = await adminLogin(w);
    const config = { ...clientConfig, workspaces: 'shared', product: 'notes', agent_access: 'on', agent_scope_catalogue: { read: 'Read notes' },
        agent_resource_prefixes: ['https://app.example/'], agent_workspace_resources: [resource] };
    for (const bad of [
        { agent_workspace_resources: ['https://other.example/mcp'] },
        { agent_workspace_resources: ['https://app.example/%6Dcp'] },
        { agent_workspace_resources: Array.from({ length: 6 }, (_, i) => `https://app.example/mcp/${i}`) },
        { agent_workspace_resources: [resource, resource] }, { agent_workspace_resources: resource },
        { workspaces: 'app' }, { product: null }, { agent_access: 'off' }
    ]) await error(await admin.post('clients', { ...config, ...bad }), 'invalid_request', 400);
    const db = w.env.DB.db;
    db.exec(`INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('reserved','default','team','Reserved',0);
        INSERT INTO workspace_resources(resource,workspace_id,client_id,created) VALUES('https://app.example/mcp','reserved','app',0)`);
    await error(await admin.post('clients', config), 'invalid_request', 400);
    db.exec('DELETE FROM workspace_resources');
    const saved = await admin.post('clients', config);
    assert.equal(saved.status, 200, await saved.clone().text());
    const { client } = await saved.json();
    assert.deepEqual(client.agent_workspace_resources, [resource]);
    await error(await admin.post('clients/notes', { version: client.version, workspaces: 'app' }), 'invalid_request', 400);
    await error(await admin.post('clients/notes', { version: client.version, agent_resource_prefixes: [] }), 'invalid_request', 400);
    assert.throws(() => db.prepare('INSERT INTO workspace_resources(resource,workspace_id,client_id,created) VALUES(?,?,?,0)')
        .run(resource, 'reserved', 'app'), /agent_workspace_resource_registered/);
});

test('consent lists only eligible workspaces in order and refuses forged, missing and duplicate choices', async t => {
    const w = await setup(t);
    w.addWorkspace('z-team', { name: 'Z <Team>' });
    w.addWorkspace('personal', { name: 'A personal workspace', role: 'owner', kind: 'personal' });
    w.addWorkspace('other-member', { role: null });
    w.addWorkspace('other-product', { product: 'tasks' });
    w.addWorkspace('closed', { status: 'closed' });
    w.addWorkspace('foreign', { realm: 'foreign' });
    const flow = await w.start();
    const html = await (await w.getConsent(flow)).text();
    assertFireMarkup(html);
    assert.doesNotMatch(html, /<script[^>]+src="\/fire\//);
    assert.deepEqual(offered(html), [['personal', false], ['z-team', false]]);
    assert.match(html, /Z &lt;Team&gt;.*Team workspace/s);
    assert.match(html, /A personal workspace.*Personal workspace/s);
    assert.match(html, /Workspace<\/dt>.*choose below/);
    assert.match(html, /formnovalidate><span>Deny/);
    for (const workspaceId of [undefined, 'other-member', 'other-product', 'closed', 'foreign', 'absent'])
        await error(await w.approve(flow, workspaceId), 'invalid_request', 400);
    const retry = await w.approve(flow, 'foreign', { headers: { accept: 'text/html' } });
    assert.equal(retry.status, 400);
    assert.ok((await retry.text()).includes(`href="${consentPath(flow)}"`));
    await error(await w.form('/agent/consent', [
        ['request_id', flow.id], ['csrf', w.csrf], ['decision', 'approve'], ['scope', 'read'],
        ['workspace_id', 'personal'], ['workspace_id', 'z-team']
    ], flow.cookie), 'invalid_request', 400);
    await error(await w.approve(flow, 'personal', { headers: { origin: 'https://foreign.example' } }), 'origin', 403);
    await error(await w.form('/agent/consent', { request_id: flow.id, csrf: 'incorrect', decision: 'approve',
        scope: 'read', workspace_id: 'personal' }, flow.cookie), 'csrf', 403);
    assert.equal(count(w, 'agent_grants'), 0);
    assert.equal(count(w, 'agent_codes'), 0);
    const denied = await w.approve(flow, undefined, { decision: 'deny' });
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
    await error(await w.approve(flow, 'personal'), 'browser_binding', 403);
});

test('the 50-item consent limit applies to both offers and submissions', async t => {
    const w = await setup(t);
    for (let i = 0; i < 51; i++) w.addWorkspace('workspace-' + String(i).padStart(2, '0'));
    const flow = await w.start();
    const options = offered(await (await w.getConsent(flow)).text());
    assert.equal(options.length, 50);
    assert.deepEqual(options.at(-1), ['workspace-49', false]);
    await error(await w.approve(flow, 'workspace-50'), 'invalid_request', 400);
    assert.equal(count(w, 'agent_grants'), 0);
});

test('no eligible workspace refuses consent in the person’s language and links to the app', async t => {
    const w = await setup(t);
    w.db.exec("UPDATE clients SET signup_policy='invited' WHERE id='app'");
    const flow = await w.start();
    const response = await w.getConsent(flow, { accept: 'text/html', 'accept-language': 'es' });
    assert.equal(response.status, 403);
    const html = await response.text();
    assert.match(html, /No perteneces a ningún espacio de trabajo que use Example App\./);
    assert.match(html, /href="https:\/\/app\.example\/sign-in"/);
    assert.doesNotMatch(html, /name="workspace_id"|Sign in again/);
    await error(await w.getConsent(flow, { accept: 'application/json' }), 'access_denied', 403);
    await error(await w.approve(flow, 'missing'), 'access_denied', 403);
    assert.equal(count(w, 'agent_grants'), 0);
});

test('membership removed in the consent write race grants nothing and leaves the browser request live', async t => {
    const w = await setup(t);
    w.addWorkspace('selected');
    const flow = await w.start();
    assert.deepEqual(offered(await (await w.getConsent(flow)).text()), [['selected', true]]);
    const batch = w.env.DB.batch;
    const intercepted = t.mock.method(w.env.DB, 'batch', statements => {
        if (statements.length > 2) w.db.prepare("DELETE FROM workspace_members WHERE workspace_id='selected'").run();
        return batch(statements);
    });
    await error(await w.approve(flow, 'selected'), 'invalid_request', 400);
    intercepted.mock.restore();
    assert.ok(w.db.prepare('SELECT id FROM auth_requests WHERE id=?').get(flow.id));
    assert.equal(count(w, 'agent_grants'), 0);
    assert.equal(count(w, 'agent_codes'), 0);
    assert.equal(count(w, 'agent_revocation_outbox'), 0);
});

test('workspace choice binds code, refresh, introspection, exchange, the account list, audit and email', async t => {
    const w = await setup(t);
    w.addWorkspace('chosen', { name: 'Engineering' });
    const tokens = await w.grant('chosen'), issued = claims(tokens.access_token);
    assert.equal(issued.workspace_id, 'chosen');
    assert.equal(issued.aud, resource);
    const rotated = await refresh(w, tokens);
    assert.equal(rotated.status, 200, await rotated.clone().text());
    assert.equal(claims((await rotated.json()).access_token).workspace_id, 'chosen');
    assert.equal((await w.introspect(tokens.access_token)).workspace_id, 'chosen');
    const exchanged = await w.form('/token', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: tokens.access_token, subject_token_type: accessTokenType, resource: target }, '', { authorization: basic() });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const exchangeToken = (await exchanged.json()).access_token;
    assert.equal(claims(exchangeToken).aud, target);
    assert.equal(claims(exchangeToken).workspace_id, 'chosen');
    assert.equal((await w.introspect(exchangeToken, 'other')).workspace_id, 'chosen');
    assert.deepEqual(await w.introspect(exchangeToken), { active: false });
    const ordinary = await w.grant(undefined, { options: { resource: ordinaryResource } });
    assert.equal(Object.hasOwn(claims(ordinary.access_token), 'workspace_id'), false);
    assert.equal(Object.hasOwn(await w.introspect(ordinary.access_token), 'workspace_id'), false);
    const account = await w.call('/v1/account/agents', { headers: { cookie: w.cookie } });
    const entry = (await account.json()).agents.find(agent => agent.id === issued.grant_id);
    assert.equal(entry.workspace_id, 'chosen');
    assert.equal(entry.workspace_name, 'Engineering');
    assert.equal(JSON.parse(w.db.prepare("SELECT detail FROM audit WHERE event='agent_grant' ORDER BY id").get().detail).workspace_id, 'chosen');
    await w.drain();
    assert.ok(w.mails.some(message => message.text.includes('Example App (Engineering)')));
});

test('device flow lists and requires the workspace and redeems a scoped token once', async t => {
    const w = await setup(t);
    w.addWorkspace('device-workspace');
    const response = await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' });
    assert.equal(response.status, 200, await response.clone().text());
    const device = await response.json();
    const browser = await w.call('/device?user_code=' + device.user_code, { headers: { cookie: w.cookie } });
    assert.equal(browser.status, 303);
    const flow = { id: new URL(browser.headers.get('location')).searchParams.get('request_id'), cookie: w.cookie + '; ' + cookieJar(browser) };
    assert.deepEqual(offered(await (await w.getConsent(flow)).text()), [['device-workspace', true]]);
    await error(await w.approve(flow, undefined), 'invalid_request', 400);
    await error(await w.approve(flow, 'invalid'), 'invalid_request', 400);
    assert.equal(w.db.prepare('SELECT status FROM agent_devices').get().status, 'pending');
    assert.equal((await w.approve(flow, 'device-workspace')).status, 200);
    w.db.exec('UPDATE agent_devices SET next_poll=0');
    const redeem = () => w.form('/token', { client_id: metadataId, resource, grant_type: deviceGrant, device_code: device.device_code });
    const redeemed = await redeem();
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    assert.equal(claims((await redeemed.json()).access_token).workspace_id, 'device-workspace');
    await error(await redeem(), 'invalid_grant');
});

test('replacements show the workspace and prevent replacing or inheriting scopes across workspaces', async t => {
    const w = await setup(t);
    w.addWorkspace('alpha', { name: 'Alpha workspace' });
    w.addWorkspace('beta', { name: 'Beta workspace' });
    const alpha = claims((await w.grant('alpha', { options: { scope: 'write' }, scope: ['write'] })).access_token).grant_id;
    const beta = claims((await w.grant('beta')).access_token).grant_id;
    const flow = await w.start(), html = await (await w.getConsent(flow)).text();
    assert.match(html, new RegExp(`name="replace" value="${alpha}"[^>]*>.*?Alpha workspace`, 's'));
    assert.match(html, new RegExp(`name="replace" value="${beta}"[^>]*>.*?Beta workspace`, 's'));
    const mismatch = await w.approve(flow, 'beta', { replace: alpha });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error_description, 'That connection is for another workspace.');
    await error(await w.approve(flow, 'beta', { scope: ['read', 'write'] }), 'invalid_request', 400);
    assert.equal(count(w, 'agent_grants'), 2);
    assert.equal((await w.approve(flow, 'alpha', { replace: alpha, scope: ['read', 'write'] })).status, 303);
    assert.deepEqual(revocations(w, alpha), ['agent_replaced']);
    assert.deepEqual(revocations(w, beta), []);
});

const endings = {
    member: { change: "DELETE FROM workspace_members WHERE workspace_id='ending'",
        apply: w => w.mutation('DELETE', 'ending', 'members/' + w.user.id) },
    product: { change: "DELETE FROM workspace_products WHERE workspace_id='ending'",
        apply: w => w.mutation('POST', 'ending', 'products', { remove: ['notes'] }) },
    close: { change: "UPDATE workspaces SET status='closed' WHERE id='ending'",
        apply: w => w.mutation('POST', 'ending', 'close') }
};

for (const [end, { change, apply }] of Object.entries(endings)) {
    test(`refresh detects ${end} loss without prior teardown, records revocation and makes introspection inactive`, async t => {
        const w = await setup(t);
        w.addWorkspace('ending');
        w.addWorkspace('retained');
        const tokens = await w.grant('ending'), keep = await w.grant('retained');
        const id = claims(tokens.access_token).grant_id;
        w.db.exec(change);
        await error(await refresh(w, tokens), 'invalid_grant', 400);
        assert.deepEqual(revocations(w, id), ['workspace_access_ended']);
        assert.ok(w.db.prepare('SELECT revoked_at FROM agent_grants WHERE id=?').get(id).revoked_at);
        assert.deepEqual(await w.introspect(tokens.access_token), { active: false });
        assert.equal((await refresh(w, keep)).status, 200);
        await w.drain();
        assert.equal(w.events.filter(event => event.type === 'agent_revocation').length, 1);
    });

    test(`workspace ${end} write revokes matching grants atomically and leaves other workspaces live`, async t => {
        const w = await setup(t);
        w.addWorkspace('ending', { role: end === 'member' ? 'member' : 'owner' });
        w.addWorkspace('retained');
        const tokens = await w.grant('ending'), keep = await w.grant('retained');
        const id = claims(tokens.access_token).grant_id;
        assert.equal((await w.introspect(tokens.access_token)).active, true);
        await apply(w);
        assert.deepEqual(revocations(w, id), ['workspace_access_ended']);
        assert.ok(w.db.prepare('SELECT revoked_at FROM agent_grants WHERE id=?').get(id).revoked_at);
        await error(await refresh(w, tokens), 'invalid_grant', 400);
        assert.deepEqual(await w.introspect(tokens.access_token), { active: false });
        assert.equal((await refresh(w, keep)).status, 200);
        assert.deepEqual(revocations(w, claims(keep.access_token).grant_id), []);
    });
}

test('introspection detects workspace access loss before refresh and revokes only once', async t => {
    const w = await setup(t);
    w.addWorkspace('ending');
    const tokens = await w.grant('ending'), id = claims(tokens.access_token).grant_id;
    w.db.exec(endings.member.change);
    assert.deepEqual(await w.introspect(tokens.access_token), { active: false });
    assert.deepEqual(await w.introspect(tokens.access_token), { active: false });
    await error(await refresh(w, tokens), 'invalid_grant', 400);
    assert.deepEqual(revocations(w, id), ['workspace_access_ended']);
});

test('an existing unscoped grant cannot issue access for a resource switched to workspace choice', async t => {
    const w = await setup(t);
    w.db.exec("UPDATE clients SET agent_workspace_resources='[]' WHERE id='app'");
    const tokens = await w.grant(undefined);
    w.db.prepare("UPDATE clients SET agent_workspace_resources=? WHERE id='app'").run(JSON.stringify([resource]));
    assert.deepEqual(await w.introspect(tokens.access_token), { active: false });
    await error(await refresh(w, tokens), 'invalid_grant', 400);
});

test('the grant API filters by workspace, requires product visibility and returns null for unscoped grants', async t => {
    const w = await setup(t);
    w.addWorkspace('first');
    w.addWorkspace('second');
    w.addWorkspace('different-product', { product: 'other' });
    w.addWorkspace('foreign', { realm: 'foreign' });
    for (const id of ['first', 'second']) await w.grant(id);
    await w.grant(undefined, { options: { resource: ordinaryResource } });
    const list = (query, auth = basic()) => w.call('/v1/grants?' + new URLSearchParams(query), { headers: { authorization: auth } });
    const data = await (await list({ resource })).json();
    assert.deepEqual(data.grants.map(item => item.workspace_id).sort(), ['first', 'second']);
    const filtered = await (await list({ resource, workspace_id: 'second', limit: 1 })).json();
    assert.deepEqual(filtered.grants.map(item => item.workspace_id), ['second']);
    assert.equal(filtered.next_cursor, null);
    assert.equal((await (await list({ resource: ordinaryResource })).json()).grants[0].workspace_id, null);
    for (const id of ['foreign', 'different-product', 'missing', ''])
        await error(await list({ resource, workspace_id: id }), 'not_found', 404);
    await error(await list({ resource, workspace_id: 'second' }, basic('other')), 'invalid_target', 403);
});

test('client verifies the workspace claim and refuses every non-string type', async t => {
    const w = await setup(t);
    w.addWorkspace('verified');
    const { access_token } = await w.grant('verified');
    const identity = createClient({ issuer: w.env.ISSUER, clientId: 'app', clientSecret: 'secret',
        fetch: (url, init) => w.call(new URL(url).pathname + new URL(url).search, init) });
    assert.equal((await identity.verifyAccessToken(access_token, { audience: resource })).workspace_id, 'verified');
    for (const workspace_id of [null, 42, {}, [], true]) {
        const invalid = await signAgentJwt(w.env, { ...claims(access_token), workspace_id });
        await assert.rejects(identity.verifyAccessToken(invalid, { audience: resource }), { code: 'invalid_token' });
    }
    const list = await identity.listGrants({ resource, workspace_id: 'verified' });
    assert.deepEqual(list.grants.map(item => item.workspace_id), ['verified']);
});

test('product removal revokes both resource modes on its apps and preserves a different product in the same workspace', async t => {
    const w = await setup(t);
    w.addWorkspace('ending', { role: 'owner' });
    w.db.exec(`UPDATE clients SET workspaces='shared',product='tasks',agent_access='on',
        agent_workspace_resources='["https://other.example/mcp"]' WHERE id='other';
        INSERT INTO workspace_products(workspace_id,product,created) VALUES('ending','tasks',0);
        INSERT INTO workspace_resources(resource,workspace_id,client_id,created)
        VALUES('https://app.example/w/team-one/mcp','ending','app',0)`);
    const choice = await w.grant('ending');
    const registered = await w.grant(undefined, { options: { resource: ordinaryResource } });
    const otherProduct = await w.grant('ending', { options: { resource: target } });
    await endings.product.apply(w);
    for (const token of [choice, registered]) {
        assert.deepEqual(revocations(w, claims(token.access_token).grant_id), ['workspace_access_ended']);
        assert.deepEqual(await w.introspect(token.access_token), { active: false });
    }
    assert.equal((await w.introspect(otherProduct.access_token, 'other')).active, true);
    assert.deepEqual(revocations(w, claims(otherProduct.access_token).grant_id), []);
});

test('refresh atomically refuses a concurrent workspace change before spending the refresh token', async t => {
    const w = await setup(t);
    w.addWorkspace('ending');
    const tokens = await w.grant('ending'), id = claims(tokens.access_token).grant_id;
    const batch = w.env.DB.batch;
    const intercepted = t.mock.method(w.env.DB, 'batch', statements => {
        w.db.exec(endings.member.change);
        return batch(statements);
    });
    await error(await refresh(w, tokens), 'invalid_grant', 400);
    intercepted.mock.restore();
    assert.deepEqual(revocations(w, id), ['workspace_access_ended']);
    assert.equal(w.db.prepare('SELECT spent_at FROM agent_refresh_tokens WHERE grant_id=?').get(id).spent_at, null);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM agent_refresh_tokens WHERE grant_id=?').get(id).n, 1);
});
