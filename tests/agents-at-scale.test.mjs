// Agents at scale: registrations kept while a grant is live, token budgets that suit hosted agents behind shared
// addresses, paging through a resource's grants, the client's grant and introspection calls, and agent_assurance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basic } from './support/world.mjs';
import { agentWorld, resource, metadataId, error } from './support/agents.mjs';
import { scheduled } from '../apps/server/src/services/maintenance.mjs';
import { resolveAgent } from '../apps/server/src/agents/registration.mjs';
import { AGENT_GRANT_PER_MINUTE } from '../apps/server/src/auth/rate-limit.mjs';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';

const claimsOf = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
const DAY = 86400000;
async function dynamicGrant(w) {
    const agent = await (await w.post('/register', { client_name: 'Monthly Assistant', redirect_uris: ['http://127.0.0.1/callback'] })).json();
    const { tokens } = await w.grant({ client_id: agent.client_id });
    return { agent, tokens };
}
const spend = (w, key, count) => w.env.DB.db.prepare('INSERT OR REPLACE INTO rate_limits(key,count,expires_at) VALUES(?,?,?)').run(key, count, Date.now() + 60000);

// Item 5: registrations with live grants.
test('a self-registration idle for over 30 days is kept while a grant made with it is live, and keeps refreshing', async t => {
    const w = await agentWorld(t), { agent, tokens } = await dynamicGrant(w);
    w.env.DB.db.prepare('UPDATE agent_clients SET last_used=? WHERE id=?').run(Date.now() - 31 * DAY, agent.client_id);
    await scheduled(w.env);
    assert.ok(w.env.DB.db.prepare('SELECT id FROM agent_clients WHERE id=?').get(agent.client_id), 'kept');
    assert.ok(await resolveAgent(w.env, agent.client_id));
    const refreshed = await w.refresh(tokens.refresh_token, { client_id: agent.client_id });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
});
test('once its grants are revoked or expired, an idle self-registration goes', async t => {
    for (const end of ["revoked_at=1", `expires_at=${Date.now() - 1000}`]) {
        const w = await agentWorld(t), { agent } = await dynamicGrant(w);
        w.env.DB.db.exec(`UPDATE agent_grants SET ${end}`);
        w.env.DB.db.prepare('UPDATE agent_clients SET last_used=? WHERE id=?').run(Date.now() - 31 * DAY, agent.client_id);
        await assert.rejects(resolveAgent(w.env, agent.client_id), error => error.code === 'invalid_client', end);
        await scheduled(w.env);
        assert.equal(w.env.DB.db.prepare('SELECT id FROM agent_clients WHERE id=?').get(agent.client_id), undefined, end);
    }
});

// Item 2: token budgets.
test('agent token requests spend the agent address budget; only refused ones spend the strict one', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant(), spent = { AGENT_LIMITER: [], API_LIMITER: [] };
    for (const name of Object.keys(spent)) w.env[name] = { async limit({ key }) { spent[name].push(key); return { success: true }; } };
    const ip = await sha256('ip:unavailable');
    assert.equal((await w.refresh(tokens.refresh_token)).status, 200);
    assert.deepEqual([spent.AGENT_LIMITER.includes(ip), spent.API_LIMITER.includes(ip)], [true, false]);
    await error(await w.refresh('x'.repeat(43)), 'invalid_grant', 400);
    assert.equal(spent.API_LIMITER.filter(key => key === ip).length, 1);
});
test('an exhausted agent address budget refuses even a valid refresh, and an exhausted strict budget refuses the next failure', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    w.env.AGENT_LIMITER = { async limit() { return { success: false }; } };
    await error(await w.refresh(tokens.refresh_token), 'rate_limit', 429);
    w.env.AGENT_LIMITER = { async limit() { return { success: true }; } };
    w.env.API_LIMITER = { async limit() { return { success: false }; } };
    await error(await w.refresh('y'.repeat(43)), 'rate_limit', 429);
    assert.equal((await w.refresh(tokens.refresh_token)).status, 200, 'a valid request does not touch the strict budget');
});
test(`one grant may make ${AGENT_GRANT_PER_MINUTE} token requests a minute`, async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    const grantId = w.env.DB.db.prepare('SELECT id FROM agent_grants').get().id;
    spend(w, 'agent-grant:' + grantId, AGENT_GRANT_PER_MINUTE);
    await error(await w.refresh(tokens.refresh_token), 'rate_limit', 429);
    // The refused request spent nothing: the token still works once the minute is over.
    w.env.DB.db.exec("UPDATE rate_limits SET expires_at=0 WHERE key LIKE 'agent-grant:%'");
    assert.equal((await w.refresh(tokens.refresh_token)).status, 200);
});
test('each agent has its own budget at each app, set by agent_token_rate', async t => {
    const w = await agentWorld(t), first = await w.grant(), other = await dynamicGrant(w);
    w.env.DB.db.exec("UPDATE clients SET agent_token_rate=10 WHERE id='app'");
    spend(w, `agent-client:app:${await sha256(metadataId)}`, 10);
    await error(await w.refresh(first.tokens.refresh_token), 'rate_limit', 429);
    // Another agent at the same app is not held back.
    assert.equal((await w.refresh(other.tokens.refresh_token, { client_id: other.agent.client_id })).status, 200);
    // Refused requests count too, so an agent that keeps trying stays held until the minute is over.
    w.env.DB.db.exec("UPDATE clients SET agent_token_rate=100 WHERE id='app'");
    assert.equal((await w.refresh(first.tokens.refresh_token)).status, 200, 'a raised rate takes effect at once');
});
test('agent_token_rate is a whole number from 10 to 100000, in the console and the seed script', async t => {
    const config = { id: 'busy', secret_hash: 'a'.repeat(64), redirect_uris: ['https://busy.example/cb'], sign_in_methods: ['email'] };
    assert.match(clientSeedSql({ ...config, agent_token_rate: 50000 }), /50000/);
    for (const bad of [9, 100001, 1.5, '3000']) assert.throws(() => clientSeedSql({ ...config, agent_token_rate: bad }), /agent_token_rate/, String(bad));
    const { saveClient } = await import('../apps/server/src/admin/clients.mjs');
    const w = await agentWorld(t);
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    await assert.rejects(saveClient(w.env, 'admin@example.com', 'app', { agent_token_rate: 0, version: 0 }), /agent_token_rate/);
    assert.equal((await saveClient(w.env, 'admin@example.com', 'app', { agent_token_rate: 20000, version: 0 })).client.agent_token_rate, 20000);
    assert.throws(() => w.env.DB.db.exec("UPDATE clients SET agent_token_rate=5 WHERE id='app'"), /CHECK/);
});

// Item 3: the grants API pages.
async function threeGrants(w) {
    for (let i = 0; i < 3; i++) await w.grant();
    // Distinct creation times, newest last.
    w.env.DB.db.prepare("SELECT id FROM agent_grants ORDER BY rowid").all().forEach((row, i) => w.env.DB.db.prepare('UPDATE agent_grants SET created=? WHERE id=?').run(1_800_000_000_000 + i, row.id));
    return w.env.DB.db.prepare('SELECT id FROM agent_grants ORDER BY created DESC').all().map(row => row.id);
}
const list = (w, params, auth = basic()) => w.call('/v1/grants?' + new URLSearchParams({ resource, ...params }), { headers: { authorization: auth } });
test('the grants API pages newest first with a cursor, and filters by person', async t => {
    const w = await agentWorld(t), ids = await threeGrants(w), seen = [];
    let cursor;
    do {
        const page = await (await list(w, { limit: '2', ...(cursor ? { cursor } : {}) })).json();
        assert.ok(page.grants.length <= 2);
        seen.push(...page.grants.map(g => g.grant_id));
        cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, ids);
    const all = await (await list(w, {})).json();
    assert.equal(all.grants.length, 3); assert.equal(all.next_cursor, null);
    assert.equal((await (await list(w, { sub: w.user.id })).json()).grants.length, 3);
    assert.equal((await (await list(w, { sub: 'someone-else' })).json()).grants.length, 0);
});
test('the grants API refuses a bad limit, cursor or sub, and another app', async t => {
    const w = await agentWorld(t);
    await threeGrants(w);
    for (const params of [{ limit: '0' }, { limit: '201' }, { limit: 'ten' }, { limit: '02' }, { cursor: 'not-a-cursor' },
        { cursor: Buffer.from('["x","y"]').toString('base64url') }, { sub: '' }, { sub: 's'.repeat(201) }])
        await error(await list(w, params), 'invalid_request', 400);
    assert.equal((await list(w, {}, basic('other', 'secret'))).status, 403);
});

// Item 4: the client's grant and introspection calls.
test('imprim-client lists, revokes and introspects through the supported calls', async t => {
    const w = await agentWorld(t), ids = await threeGrants(w);
    const fetch = (url, init = {}) => { const u = new URL(url); return w.call(u.pathname + u.search, init); };
    const client = createClient({ issuer: w.env.ISSUER, clientId: 'app', clientSecret: 'secret', fetch });
    const first = await client.listGrants({ resource, limit: 2 });
    assert.equal(first.grants.length, 2); assert.ok(first.next_cursor);
    const rest = await client.listGrants({ resource, limit: 2, cursor: first.next_cursor });
    assert.deepEqual([...first.grants, ...rest.grants].map(g => g.grant_id), ids);
    assert.equal(rest.next_cursor, null);
    const { tokens } = await w.grant();
    const live = await client.introspect(tokens.access_token);
    assert.equal(live.active, true); assert.equal(live.sub, w.user.id); assert.equal(live.agent_assurance, 'claimed');
    assert.deepEqual(await client.revokeGrant(live.grant_id), { grant_id: live.grant_id, revoked: true });
    assert.deepEqual(await client.introspect(tokens.access_token), { active: false });
    await assert.rejects(client.revokeGrant('missing'), error => error.code === 'not_found');
    const publicClient = createClient({ issuer: w.env.ISSUER, clientId: 'app', fetch });
    for (const call of [() => publicClient.listGrants({ resource }), () => publicClient.revokeGrant('g'), () => publicClient.introspect('t')])
        await assert.rejects(call(), error => error.code === 'configuration');
    await assert.rejects(client.listGrants({ resource: 'http://app.example/w/x' }), error => error.code === 'configuration');
    await assert.rejects(client.listGrants({ resource, limit: 500 }), error => error.code === 'configuration');
});

// Item 6: agent_assurance.
test('agent tokens and the grant list carry the assurance the consent page showed', async t => {
    const w = await agentWorld(t), metadataGrant = await w.grant(), dynamic = await dynamicGrant(w);
    assert.equal(claimsOf(metadataGrant.tokens.access_token).agent_assurance, 'claimed'); // a loopback callback
    assert.equal(claimsOf(dynamic.tokens.access_token).agent_assurance, 'none');
    const listed = await (await list(w, {})).json();
    assert.deepEqual(listed.grants.map(g => g.agent_assurance).sort(), ['claimed', 'none']);
    // A grant from before agent_assurance existed carries no claim, rather than a guess.
    w.env.DB.db.exec('UPDATE agent_grants SET assurance=NULL');
    const refreshed = await (await w.refresh(metadataGrant.tokens.refresh_token)).json();
    assert.equal(claimsOf(refreshed.access_token).agent_assurance, undefined);
});
