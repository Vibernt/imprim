import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, metadataId, resource, error } from './support/agents.mjs';
import { cookieJar } from './support/world.mjs';
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';
async function setup(t) {
    const w = await agentWorld(t);
    const response = await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' });
    assert.equal(response.status, 200, await response.clone().text());
    const device = await response.json();
    const poll = (change = {}) => w.form('/token', { client_id: metadataId, resource, grant_type: DEVICE, device_code: device.device_code, ...change });
    const ready = () => w.env.DB.db.exec('UPDATE agent_devices SET next_poll=0');
    const browser = async () => {
        const response = await w.call('/device?user_code=' + device.user_code, { headers: { cookie: w.cookie } });
        assert.equal(response.status, 303, await response.clone().text());
        return { id: new URL(response.headers.get('location')).searchParams.get('request_id'), cookie: w.cookie + '; ' + cookieJar(response), scopes: ['read'] };
    };
    return { ...w, device, poll, ready, browser };
}

test('device user-code entry, pending, permanent slow_down, consent, tokens and single-use redemption', async t => {
    const w = await setup(t);
    assert.match(w.device.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.equal(w.device.interval, 5); assert.equal(w.device.expires_in, 600);
    assert.equal(w.device.verification_uri, w.env.ISSUER + '/device');
    assert.equal(w.device.verification_uri_complete, w.env.ISSUER + '/device?user_code=' + w.device.user_code);
    w.ready(); await error(await w.poll(), 'authorization_pending');
    await error(await w.poll(), 'slow_down'); assert.equal(w.env.DB.db.prepare('SELECT interval FROM agent_devices').get().interval, 10);
    await error(await w.poll(), 'slow_down'); assert.equal(w.env.DB.db.prepare('SELECT interval FROM agent_devices').get().interval, 15);
    const browser = await w.browser();
    const consent = await w.call('/agent/consent?request_id=' + browser.id, { headers: { cookie: browser.cookie } });
    const consentHtml = await consent.text();
    assert.match(consentHtml, /Example Agent.*team-one.*Read workspace/s);
    // A device code reaches whoever started the flow, so the device consent always carries the phishing alert.
    assert.match(consentHtml, /<div class="fd-callout" data-tone="danger" role="alert">/);
    const entry = await (await w.call('/device', { headers: { cookie: w.cookie } })).text();
    assert.match(entry, /<form class="fd-stack" data-gap="4" method="get" action="\/device"><div class="fd-field"><label class="fd-field-label" for="user_code">Device code<\/label><input class="fd-input"[^>]* name="user_code"[^>]* required/);
    const approved = await w.approve(browser); assert.equal(approved.status, 200);
    assert.match(await approved.text(), /<h1 class="fd-h1">Agent connected<\/h1>/);
    w.ready(); const tokens = await (await w.poll()).json(); assert.ok(tokens.access_token); assert.ok(tokens.refresh_token);
    const claim = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url')); assert.equal(claim.aud, resource); assert.equal(claim.sub, w.user.id);
    await error(await w.poll(), 'invalid_grant'); assert.equal((await w.refresh(tokens.refresh_token)).status, 200);
});

test('device denial is returned to poller and cannot be approved again', async t => {
    const w = await setup(t), browser = await w.browser();
    assert.equal((await w.approve(browser, 'deny')).status, 200);
    w.ready(); await error(await w.poll(), 'access_denied');
    await error(await w.call('/device?user_code=' + w.device.user_code), 'expired_token');
    assert.ok((await w.approve(browser)).status >= 400);
});

test('device expires at polling, user entry and consent; expired device cannot create a grant', async t => {
    const w = await setup(t), browser = await w.browser();
    w.env.DB.db.exec('UPDATE agent_devices SET expires_at=0');
    await error(await w.poll(), 'expired_token');
    await error(await w.call('/device?user_code=' + w.device.user_code), 'expired_token');
    await error(await w.approve(browser), 'expired_token');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 0);
});

test('device is bound to exact agent and resource; concurrent redemption has one winner', async t => {
    const w = await setup(t), browser = await w.browser();
    await w.approve(browser); w.ready();
    await error(await w.poll({ resource: 'https://app.example/w/other/mcp' }), 'invalid_grant');
    await error(await w.poll({ client_id: 'agent_wrong' }), 'invalid_grant');
    const results = await Promise.all([w.poll(), w.poll()]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_refresh_tokens').get().n, 1);
});

for (const sql of ["agent_access='off'", `agent_allowlist='["other.example"]'`, `agent_scope_catalogue='{"write":"Edit"}'`, `agent_registration_methods='["dynamic"]'`, `agent_resource_prefixes='["https://elsewhere.example/"]'`])
    test(`device rechecks policy ${sql}`, async t => {
        const w = await setup(t), browser = await w.browser();
        w.env.DB.db.exec(`UPDATE clients SET ${sql} WHERE id='app'`);
        for (const response of [await w.poll(), await w.approve(browser), await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' })]) assert.ok(response.status >= 400);
    });

test('separate browsers cannot both approve the same device', async t => {
    const w = await setup(t), first = await w.browser(), second = await w.browser();
    const results = await Promise.all([w.approve(first), w.approve(second)]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_grants').get().n, 1);
});

test('user-code attempts are rate limited separately from API traffic', async t => {
    const w = await setup(t);
    for (let i = 0; i < 20; i++) assert.equal((await w.call('/device?user_code=BBBB-BBBB')).status, 400);
    await error(await w.call('/device?user_code=BBBB-BBBB'), 'rate_limit', 429);
});
