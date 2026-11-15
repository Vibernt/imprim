import test from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_GRACE_MS, REFRESH_BUDGET_PER_DAY } from '../apps/server/src/agents/token.mjs';
import { agentWorld, metadataId, resource, error } from './support/agents.mjs';
import { createClient, wwwAuthenticate } from '../packages/imprim-client/index.mjs';
import { queue } from '../apps/server/src/services/maintenance.mjs';

test('MCP resource challenge → discovery → metadata registration → consent → JWT → refresh → revoke', async t => {
    const w = await agentWorld(t);
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', redirectUri: 'https://app.example/callback',
        fetch: (url, init) => w.call(new URL(url).pathname, init) });
    const resourceMetadataUrl = 'https://app.example/.well-known/oauth-protected-resource/w/team-one/mcp';
    async function mcp(request) {
        if (request.url === resourceMetadataUrl) return Response.json(client.protectedResourceMetadata({ resource, scopes: ['read','write'] }));
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        if (!token) return new Response(null, { status: 401, headers: { 'www-authenticate': wwwAuthenticate({ resourceMetadataUrl }) } });
        const claims = await client.verifyAccessToken(token, { audience: resource });
        // Fixture resource still intersects person membership and scopes; identity does not grant membership.
        if (claims.sub !== w.user.id || !claims.scope.split(' ').includes('read')) return new Response(null, { status: 403 });
        return Response.json({ workspace: 'team-one', sub: claims.sub });
    }
    const challenge = await mcp(new Request(resource)); assert.equal(challenge.status, 401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate'))[1];
    const prm = await (await mcp(new Request(metadataUrl))).json();
    assert.equal(prm.resource, resource); assert.deepEqual(prm.authorization_servers, [w.env.ISSUER]);
    const discovery = await (await w.call('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
    assert.equal(discovery.client_id_metadata_document_supported, true);
    assert.equal(discovery.device_authorization_endpoint, w.env.ISSUER + '/device_authorization');
    assert.equal(discovery.registration_endpoint, w.env.ISSUER + '/register');
    assert.deepEqual(discovery, await (await w.call('/.well-known/openid-configuration')).json());
    const flow = await w.start(); assert.equal(flow.response.status, 303);
    const consent = await w.call(`/agent/consent?request_id=${flow.id}`, { headers: { cookie: flow.cookie } });
    const html = await consent.text();
    for (const text of ['Example Agent','agent.example','Example App','team-one','Read workspace']) assert.ok(html.includes(text));
    // The consent form redirects to the agent's callback, so form-action names that origin and nothing else changes.
    assert.equal(consent.headers.get('content-security-policy'),
        (await w.call('/device')).headers.get('content-security-policy').replace("form-action 'self'", "form-action 'self' http://127.0.0.1:4567"));
    const approved = await w.approve(flow), code = new URL(approved.headers.get('location')).searchParams.get('code');
    const tokens = await (await w.exchange(code)).json(); assert.equal(tokens.expires_in, 60);
    const claims = await client.verifyAccessToken(tokens.access_token, { audience: resource });
    for (const key of ['iss','aud','sub','client_id','scope','jti','iat','exp']) assert.ok(claims[key]);
    assert.equal(claims.client_id, metadataId); assert.equal(claims.sub, w.user.id);
    assert.equal((await mcp(new Request(resource, { headers: { authorization: `Bearer ${tokens.access_token}` } }))).status, 200);
    await assert.rejects(client.verifyAccessToken(tokens.access_token, { audience: 'https://app.example/w/team-two/mcp' }), /audience/);
    // Code replay revokes the grant (S16); see 'a replayed agent code revokes the grant it created'.
    assert.ok(Number.isInteger(claims.grant_issued_at) && claims.grant_issued_at <= claims.iat && claims.iat - claims.grant_issued_at < 60, 'the approval time');
    const next = await (await w.refresh(tokens.refresh_token)).json(); assert.notEqual(next.refresh_token, tokens.refresh_token);
    const refreshed = await client.verifyAccessToken(next.access_token, { audience: resource });
    assert.equal(refreshed.sub, w.user.id);
    assert.equal(refreshed.grant_issued_at, claims.grant_issued_at, 'a refresh never moves the approval time');
    const grant = w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    const account = await w.call('/account/agents', { headers: { cookie: w.cookie } }); assert.match(await account.text(), /Connected agents.*Example Agent/s);
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    assert.equal((await w.form('/account/revoke', { grant_id: grant.id, csrf: w.csrf }, w.cookie)).status, 303);
    await w.drain();
    assert.equal(w.events.length, 1);
    await error(await w.refresh(next.refresh_token), 'invalid_grant');
    const audit = w.env.DB.db.prepare("SELECT event FROM audit WHERE event LIKE 'agent_%'").all().map(x => x.event);
    for (const event of ['agent_grant','agent_token','agent_revoke']) assert.ok(audit.includes(event));
    assert.ok(!audit.includes('agent_refresh'), 'a refresh writes no audit row (S5)');
    assert.equal(w.env.DB.db.prepare('SELECT hash FROM agent_refresh_tokens LIMIT 1').get().hash.length, 64);
});

test('refresh reuse after the grace window revokes the entire family', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    const next = await (await w.refresh(tokens.refresh_token)).json();
    w.env.DB.db.prepare('UPDATE agent_refresh_tokens SET spent_at=spent_at-? WHERE spent_at IS NOT NULL').run(REFRESH_GRACE_MS + 1);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
    await error(await w.refresh(next.refresh_token), 'invalid_grant');
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='agent_refresh_reuse'").get().n, 1);
});
test('a retry after a lost refresh response succeeds once; the lost replacement then trips reuse detection', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    const lost = await (await w.refresh(tokens.refresh_token)).json();
    const retried = await w.refresh(tokens.refresh_token);
    assert.equal(retried.status, 200, await retried.clone().text());
    const kept = await retried.json();
    assert.notEqual(kept.refresh_token, lost.refresh_token);
    // A thief who raced the owner holds `lost` (or the owner does): presenting it revokes the grant.
    await error(await w.refresh(lost.refresh_token), 'invalid_grant');
    await error(await w.refresh(kept.refresh_token), 'invalid_grant');
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='agent_refresh_reuse'").get().n, 1);
});
test('a grace retry is refused once the replacement has been used', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    const next = await (await w.refresh(tokens.refresh_token)).json();
    assert.equal((await w.refresh(next.refresh_token)).status, 200);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='agent_refresh_reuse'").get().n, 1);
});
test('concurrent refreshes leave exactly one live refresh token', async t => {
    const w = await agentWorld(t), second = await w.grant();
    const results = await Promise.all([w.refresh(second.tokens.refresh_token), w.refresh(second.tokens.refresh_token)]);
    const bodies = await Promise.all(results.map(r => r.json()));
    const live = bodies.filter(body => body.refresh_token).map(body => body.refresh_token);
    const unspent = w.env.DB.db.prepare('SELECT count(*) n FROM agent_refresh_tokens WHERE spent_at IS NULL').get().n;
    assert.equal(unspent, 1);
    assert.ok(live.length >= 1);
});
test('refresh can narrow the access token scope but never widen it; the refresh token keeps the grant', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant({ scope: 'read write' });
    const narrowed = await (await w.refresh(tokens.refresh_token, { scope: 'read' })).json();
    assert.equal(narrowed.scope, 'read');
    assert.equal(JSON.parse(Buffer.from(narrowed.access_token.split('.')[1], 'base64url')).scope, 'read');
    const full = await (await w.refresh(narrowed.refresh_token)).json();
    assert.equal(full.scope, 'read write');
    for (const scope of ['admin', 'read admin', 'read read', '']) await error(await w.refresh(full.refresh_token, { scope }), 'invalid_scope');
});
test('a replayed agent code revokes the grant it created (S16)', async t => {
    const w = await agentWorld(t), { code, tokens } = await w.grant();
    await error(await w.exchange(code), 'invalid_grant');
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='agent_code_replay'").get().n, 1);
    await error(await w.exchange('x'.repeat(43)), 'invalid_grant');
});
test('a grant has a daily refresh budget', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    const grant = w.env.DB.db.prepare('SELECT id FROM agent_grants').get().id;
    const insert = w.env.DB.db.prepare('INSERT INTO agent_refresh_tokens(hash,grant_id,spent_at,created) VALUES(?,?,?,?)');
    for (let i = 0; i < REFRESH_BUDGET_PER_DAY; i++) insert.run('filler' + i, grant, Date.now(), Date.now());
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
});
test('backchannel revocation delivery signs an event, retries failures, and keeps unknown messages pending', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    const grant = w.env.DB.db.prepare('SELECT * FROM agent_grants').get();
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    await w.form('/account/revoke', { grant_id: grant.id, csrf: w.csrf }, w.cookie);
    let ack = 0, retry = 0, status = 503;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://app.example/backchannel'); assert.equal(init.redirect, 'manual');
        const token = new URLSearchParams(init.body).get('revocation_token');
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
        assert.equal(claims.grant_id, grant.id); assert.equal(claims.aud, 'app'); assert.equal(claims.resource, resource);
        return new Response(null, { status });
    });
    const message = { body: w.events[0], ack() { ack++; }, retry() { retry++; } };
    await queue({ messages: [message] }, w.env); assert.equal(retry, 1); assert.equal(ack, 0);
    status = 204; await queue({ messages: [message] }, w.env); assert.equal(ack, 1);
    await queue({ messages: [{ ...message, body: { type: 'other' } }] }, w.env); assert.equal(retry, 2);
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
});
