import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, metadataId, resource, error } from './support/agents.mjs';
import { accountSession, change, checkBoundaries, read } from './support/account-api.mjs';
import { cookieJar } from './support/world.mjs';
import { MAX_LIVE_GRANTS } from '../apps/server/src/agents/consent.mjs';

const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';
const approvalBrowser = { 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/126.0', 'cf-ipcountry': 'FR' };
const claims = tokens => JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url'));
const consentPath = flow => '/agent/consent?request_id=' + encodeURIComponent(flow.id);
const consent = (w, flow) => w.call(consentPath(flow), { headers: { cookie: flow.cookie } });
const submit = (w, flow, scopes, { replace = '', decision = 'approve', headers = {} } = {}) => w.form('/agent/consent', [
    ['request_id', flow.id], ['csrf', w.csrf], ['decision', decision], ['replace', replace], ...scopes.map(scope => ['scope', scope])
], flow.cookie, headers);
const outbox = db => db.prepare('SELECT grant_id,uri,reason FROM agent_revocation_outbox').all().map(row => ({ ...row }));
const audit = (db, event) => db.prepare('SELECT detail FROM audit WHERE event=? ORDER BY id').all(event).map(row => JSON.parse(row.detail));
const isLive = (db, id) => db.prepare('SELECT revoked_at IS NULL AND expires_at>? AS live FROM agent_grants WHERE id=?').get(Date.now(), id).live === 1;
const liveCount = db => db.prepare('SELECT count(*) AS n FROM agent_grants WHERE revoked_at IS NULL AND expires_at>?').get(Date.now()).n;
const offered = (page, name) => [...page.matchAll(new RegExp(`name="${name}" value="([^"]*)"( checked)?`, 'g'))].map(([, value, checked]) => [value, Boolean(checked)]);
const rename = (w, grant_id, label, cookie = w.cookie) => change(w, 'agents/label', { grant_id, label }, cookie);

async function exchange(w, response) {
    assert.equal(response.status, 303, await response.clone().text());
    const code = new URL(response.headers.get('location')).searchParams.get('code');
    assert.ok(code);
    const token = await w.exchange(code);
    assert.equal(token.status, 200, await token.clone().text());
    return token.json();
}

async function refusedChoice(w, flow, scopes, message, replace = '') {
    const response = await submit(w, flow, scopes, { replace });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request', error_description: message });
    const browser = await submit(w, flow, scopes, { replace, headers: { accept: 'text/html' } });
    assert.equal(browser.status, 400);
    const html = await browser.text();
    assert.ok(html.includes(message));
    assert.ok(html.includes(`href="${consentPath(flow)}"`));
    assert.match(html, />Choose again</);
}

async function startDevice(w, scope) {
    const response = await w.form('/device_authorization', { client_id: metadataId, resource, scope }, '', {
        'user-agent': 'curl/8.0', 'cf-ipcountry': 'CA'
    });
    assert.equal(response.status, 200, await response.clone().text());
    const device = await response.json();
    const browser = await w.call('/device?user_code=' + device.user_code, { headers: { cookie: w.cookie } });
    assert.equal(browser.status, 303);
    return { id: new URL(browser.headers.get('location')).searchParams.get('request_id'), cookie: w.cookie + '; ' + cookieJar(browser),
        poll: () => w.form('/token', { client_id: metadataId, resource, grant_type: DEVICE, device_code: device.device_code }) };
}

function copyGrant(db, from, { id = crypto.randomUUID(), user = from.user_id, client = from.client_id,
    app = from.app_id, target = from.resource, created = from.created - 1, expires = from.expires_at, revoked = null } = {}) {
    db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, client, from.client_name, from.registration_method, app, user, target,
        from.scope, from.method, created, created, expires, revoked);
    return id;
}

test('approval grants only the checked scopes in code exchange, JWT, refresh, audit and email', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, flow = await w.start({ scope: 'read write' });
    const page = await (await consent(w, flow)).text();
    assert.deepEqual(offered(page, 'scope'), [['read', true], ['write', true]]);
    assert.match(page, /<form[^>]+action="\/agent\/consent"[\s\S]+type="checkbox"[\s\S]+>Approve<[\s\S]+>Deny<[\s\S]+<\/form>/);
    assert.match(page, /Edit workspace <code class="fd-mono-sm">write<\/code>/);
    assert.doesNotMatch(page, /<script[^>]+src="\/fire\/| style=|Already connected/);
    const tokens = await exchange(w, await submit(w, flow, ['write']));
    assert.equal(tokens.scope, 'write');
    const { grant_id } = claims(tokens);
    assert.equal(claims(tokens).scope, 'write');
    assert.equal(db.prepare('SELECT scope FROM agent_grants WHERE id=?').get(grant_id).scope, 'write');
    await error(await w.refresh(tokens.refresh_token, { scope: 'read write' }), 'invalid_scope');
    const refreshed = await w.refresh(tokens.refresh_token);
    assert.equal(refreshed.status, 200);
    const rotated = await refreshed.json();
    assert.equal(rotated.scope, 'write');
    assert.equal(claims(rotated).scope, 'write');
    assert.deepEqual(audit(db, 'agent_grant'), [{ grant_id, app_id: 'app', resource, scope: 'write', requested_scope: 'read write' }]);
    await w.drain();
    assert.match(w.mails.at(-1).text, /with: write\./);
});

test('empty, unoffered and duplicate scopes leave consent live and link back to it', async t => {
    const w = await agentWorld(t), flow = await w.start();
    await refusedChoice(w, flow, [], 'Choose at least one permission.');
    await refusedChoice(w, flow, ['read', 'write'], 'That permission was not offered.');
    await refusedChoice(w, flow, ['read', 'read'], 'That permission was not offered.');
    await error(await w.form('/agent/consent', [
        ['request_id', flow.id], ['csrf', w.csrf], ['decision', 'deny'], ['decision', 'approve'], ['scope', 'read']
    ], flow.cookie), 'invalid_request', 400);
    assert.equal(liveCount(w.env.DB.db), 0);
    assert.equal((await exchange(w, await submit(w, flow, ['read']))).scope, 'read');
});

test('device approval narrows to the selected scopes and records the approving browser', async t => {
    const w = await agentWorld(t), flow = await startDevice(w, 'read write'), db = w.env.DB.db;
    assert.deepEqual(offered(await (await consent(w, flow)).text(), 'scope'), [['read', true], ['write', true]]);
    assert.equal((await submit(w, flow, ['read'], { headers: approvalBrowser })).status, 200);
    db.exec('UPDATE agent_devices SET next_poll=0');
    const redeemed = await flow.poll();
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    const tokens = await redeemed.json();
    assert.equal(tokens.scope, 'read');
    assert.equal(claims(tokens).scope, 'read');
    await error(await w.refresh(tokens.refresh_token, { scope: 'write' }), 'invalid_scope');
    assert.deepEqual({ ...db.prepare('SELECT approved_device,approved_location FROM agent_grants').get() },
        { approved_device: 'Firefox on Linux', approved_location: 'FR' });
});

test('account labels are private, trimmed, clearable and writable on live, expired and revoked grants', async t => {
    const w = await agentWorld(t), db = w.env.DB.db;
    const flow = await w.start();
    const { grant_id } = claims(await exchange(w, await submit(w, flow, ['read'], { headers: approvalBrowser })));
    const list = async () => (await (await read(w, 'agents', w.cookie)).json()).agents;
    const [agent] = await list();
    assert.equal(agent.label, null);
    assert.equal(agent.approved_device, 'Firefox on Linux');
    assert.equal(agent.approved_location, 'FR');
    const original = db.prepare('SELECT * FROM agent_grants WHERE id=?').get(grant_id);
    const expired = copyGrant(db, original, { expires: 0 }), revoked = copyGrant(db, original, { revoked: Date.now() });
    for (const id of [grant_id, expired, revoked]) {
        const response = await rename(w, id, '  My laptop  ');
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await list()).find(agent => agent.id === id).label, 'My laptop');
    }
    assert.equal((await rename(w, grant_id, '  ')).status, 200);
    assert.equal((await list()).find(agent => agent.id === grant_id).label, null);
    assert.equal((await rename(w, grant_id, '🌲'.repeat(60))).status, 200);
    for (const bad of ['a'.repeat(61), '🌲'.repeat(61), 'no\u0000name', '\tname', 'no\u0085name', null]) {
        await error(await rename(w, grant_id, bad), 'invalid_request', 400);
    }
    assert.equal((await list()).find(agent => agent.id === grant_id).label, '🌲'.repeat(60));
    assert.deepEqual(audit(db, 'agent_grant_label'), [grant_id, expired, revoked, grant_id, grant_id].map(grant_id => ({ grant_id })));
});

test('account label writes enforce session, CSRF, Origin, ownership, realm and rate limits', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant();
    const { grant_id } = claims(tokens), other = await accountSession(w, 'other@example.com');
    await checkBoundaries(w, w.cookie, [], ['agents/label']);
    const unexpected = await rename(w, grant_id, 'Other person', other.cookie);
    const missing = await rename(w, crypto.randomUUID(), 'No connection', other.cookie);
    assert.equal(unexpected.status, 404);
    assert.equal(missing.status, 404);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, 'not_found');
    assert.deepEqual(await unexpected.json(), missingBody);
    db.exec(`INSERT INTO realms(id,issuer,display_name,created) VALUES('second','https://second.example','Second',0);
        INSERT INTO clients(id,secret_hash,redirect_uris,signup_policy,sign_in_methods,realm_id)
        SELECT 'second-app',secret_hash,redirect_uris,signup_policy,sign_in_methods,'second' FROM clients WHERE id='other'`);
    const foreign = copyGrant(db, db.prepare('SELECT * FROM agent_grants WHERE id=?').get(grant_id), { app: 'second-app' });
    await error(await rename(w, foreign, 'Other realm'), 'not_found', 404);
    assert.ok(!(await (await read(w, 'agents', w.cookie)).json()).agents.some(agent => agent.id === foreign));
    t.mock.method(w.env.API_LIMITER, 'limit', async () => ({ success: false }));
    await error(await rename(w, grant_id, 'Limited'), 'rate_limit', 429);
    assert.deepEqual(audit(db, 'agent_grant_label'), []);
});

test('replacing a connection carries checked permissions and revokes the old grant with its outbox and audit', async t => {
    const w = await agentWorld(t), db = w.env.DB.db;
    db.exec("UPDATE clients SET backchannel_uri='https://app.example/revocations' WHERE id='app'");
    const first = await exchange(w, await submit(w, await w.start({ scope: 'write' }), ['write'], { headers: approvalBrowser }));
    const oldId = claims(first).grant_id;
    assert.equal((await rename(w, oldId, 'Work laptop')).status, 200);
    const flow = await w.start(), page = await (await consent(w, flow)).text();
    assert.ok(page.indexOf('Already connected') < page.indexOf('What it can do'));
    assert.deepEqual(offered(page, 'replace'), [[oldId, true], ['', false]]);
    assert.deepEqual(offered(page, 'scope'), [['read', true], ['write', true]]);
    assert.match(page, /Work laptop.*Approved on Firefox on Linux · FR · Connected .* · write/s);
    assert.match(page, /Edit workspace <code class="fd-mono-sm">write<\/code> · Already allowed/);
    const tokens = await exchange(w, await submit(w, flow, ['write', 'read'], { replace: oldId }));
    const newId = claims(tokens).grant_id;
    assert.equal(tokens.scope, 'read write');
    assert.equal(claims(tokens).scope, 'read write');
    assert.equal(isLive(db, oldId), false);
    assert.equal(isLive(db, newId), true);
    await error(await w.refresh(first.refresh_token), 'invalid_grant');
    const narrowed = await w.refresh(tokens.refresh_token, { scope: 'write' });
    assert.equal(narrowed.status, 200);
    const rotated = await narrowed.json();
    assert.equal(rotated.scope, 'write');
    assert.equal(claims(rotated).scope, 'write');
    assert.deepEqual(outbox(db), [{ grant_id: oldId, uri: 'https://app.example/revocations', reason: 'agent_replaced' }]);
    assert.deepEqual(audit(db, 'agent_replaced'), [{ grant_id: oldId }]);
    assert.deepEqual(audit(db, 'agent_grant').at(-1), { grant_id: newId, app_id: 'app', resource, scope: 'read write', replaced: oldId });
    await w.drain();
    assert.equal(w.events.filter(event => event.type === 'agent_revocation').length, 1);
});

test('deny ignores scope and replacement values, and keeping both leaves the old grant live', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant({ scope: 'write' });
    const oldId = claims(tokens).grant_id;
    const denied = await submit(w, await w.start(), ['forged', 'forged'], { replace: oldId, decision: 'deny' });
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'access_denied');
    assert.equal(liveCount(db), 1);
    const second = await exchange(w, await submit(w, await w.start(), ['read']));
    assert.equal(second.scope, 'read');
    assert.equal(isLive(db, oldId), true);
    assert.equal(liveCount(db), 2);
    assert.deepEqual(outbox(db), []);
    assert.equal((await w.refresh(tokens.refresh_token)).status, 200);
});

test('replacement rejects grants outside the offered person, client, app, resource or live set', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant();
    const id = claims(tokens).grant_id, original = db.prepare('SELECT * FROM agent_grants WHERE id=?').get(id);
    const other = await accountSession(w, 'other@example.com');
    const refused = [
        copyGrant(db, original, { user: other.user.id }),
        copyGrant(db, original, { target: 'https://app.example/w/elsewhere/mcp' }),
        copyGrant(db, original, { client: 'https://other.example/client.json' }),
        copyGrant(db, original, { app: 'other' }),
        copyGrant(db, original, { revoked: Date.now() }),
        copyGrant(db, original, { expires: 0 })
    ];
    const flow = await w.start(), count = liveCount(db);
    assert.deepEqual(offered(await (await consent(w, flow)).text(), 'replace'), [[id, true], ['', false]]);
    for (const replace of refused) await refusedChoice(w, flow, ['read'], 'That connection can no longer be replaced.', replace);
    db.prepare('UPDATE agent_grants SET revoked_at=? WHERE id=?').run(Date.now(), id);
    await refusedChoice(w, flow, ['read'], 'That connection can no longer be replaced.', id);
    assert.equal(liveCount(db), count - 1);
    assert.equal(audit(db, 'agent_grant').length, 1);
    assert.deepEqual(outbox(db), []);
    assert.equal((await exchange(w, await submit(w, flow, ['read']))).scope, 'read');
});

test('a replacement revoked just before the consent batch cannot issue a grant, code, audit or outbox row', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant();
    const oldId = claims(tokens).grant_id, flow = await w.start();
    assert.deepEqual(offered(await (await consent(w, flow)).text(), 'replace'), [[oldId, true], ['', false]]);
    const batch = w.env.DB.batch;
    const intercepted = t.mock.method(w.env.DB, 'batch', statements => {
        db.prepare('UPDATE agent_grants SET revoked_at=? WHERE id=?').run(Date.now(), oldId);
        return batch(statements);
    });
    await error(await submit(w, flow, ['read'], { replace: oldId }), 'invalid_request', 400);
    assert.equal(intercepted.mock.callCount(), 1);
    intercepted.mock.restore();
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_grants').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_codes').get().n, 0);
    assert.equal(audit(db, 'agent_grant').length, 1);
    assert.deepEqual(outbox(db), []);
    assert.equal((await exchange(w, await submit(w, flow, ['read']))).scope, 'read');
});

test('a failed replacement outbox write rolls back the approval', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant();
    const oldId = claims(tokens).grant_id, flow = await w.start();
    db.exec(`CREATE TRIGGER reject_revocation BEFORE INSERT ON agent_revocation_outbox
        BEGIN SELECT RAISE(ABORT, 'test outbox write failure'); END`);
    await error(await submit(w, flow, ['read'], { replace: oldId }), 'server_error', 500);
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_grants').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM agent_codes').get().n, 0);
    assert.equal(audit(db, 'agent_grant').length, 1);
    assert.equal(isLive(db, oldId), true);
    assert.deepEqual(outbox(db), []);
    db.exec('DROP TRIGGER reject_revocation');
    await exchange(w, await submit(w, flow, ['read'], { replace: oldId }));
    assert.equal(isLive(db, oldId), false);
});

test('permissions removed from the catalogue are no longer offered or accepted from earlier grants', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant({ scope: 'write' });
    const oldId = claims(tokens).grant_id, flow = await w.start();
    assert.deepEqual(offered(await (await consent(w, flow)).text(), 'scope'), [['read', true], ['write', true]]);
    db.exec("UPDATE clients SET agent_scope_catalogue=json_remove(agent_scope_catalogue,'$.write') WHERE id='app'");
    assert.deepEqual(offered(await (await consent(w, flow)).text(), 'scope'), [['read', true]]);
    await refusedChoice(w, flow, ['read', 'write'], 'That permission was not offered.', oldId);
    assert.equal(isLive(db, oldId), true);
    assert.equal((await exchange(w, await submit(w, flow, ['read'], { replace: oldId }))).scope, 'read');
});

test('device flow never offers earlier connections or their scopes and refuses a forged replacement', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant({ scope: 'write' });
    const oldId = claims(tokens).grant_id, flow = await startDevice(w, 'read');
    const page = await (await consent(w, flow)).text();
    assert.doesNotMatch(page, /Already connected|Already allowed|name="replace"/);
    assert.deepEqual(offered(page, 'scope'), [['read', true]]);
    await refusedChoice(w, flow, ['read'], 'That connection can no longer be replaced.', oldId);
    await refusedChoice(w, flow, ['read', 'write'], 'That permission was not offered.');
    assert.equal(liveCount(db), 1);
    assert.equal((await submit(w, flow, ['read'])).status, 200);
    assert.equal(liveCount(db), 2);
    assert.equal(isLive(db, oldId), true);
    assert.deepEqual(outbox(db), []);
});

test('replacement choices are bounded and the selected grant does not count against the live cap', async t => {
    const w = await agentWorld(t), db = w.env.DB.db, { tokens } = await w.grant();
    const id = claims(tokens).grant_id, original = db.prepare('SELECT * FROM agent_grants WHERE id=?').get(id);
    const fillers = Array.from({ length: MAX_LIVE_GRANTS - 1 }, (_, i) => copyGrant(db, original, { created: original.created - i - 1 }));
    const flow = await w.start(), page = await (await consent(w, flow)).text();
    assert.deepEqual(offered(page, 'replace'), [[id, true], ...fillers.slice(0, 4).map(id => [id, false]), ['', false]]);
    await error(await submit(w, flow, ['read']), 'access_denied', 403);
    await error(await submit(w, flow, ['read'], { replace: fillers[4] }), 'invalid_request', 400);
    await exchange(w, await submit(w, flow, ['read'], { replace: id }));
    assert.equal(isLive(db, id), false);
    assert.equal(liveCount(db), MAX_LIVE_GRANTS);
});
