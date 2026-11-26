import assert from 'node:assert/strict';
import test from 'node:test';
import { completeAuthorization } from '../apps/server/src/oidc/requests.mjs';
import { assertFireMarkup } from './support/admin.mjs';
import { agentWorld, error } from './support/agents.mjs';
import { begin, cookieJar } from './support/world.mjs';
import { addTeam, configureJoin, jarOf, joinWorld } from './support/workspace-join.mjs';

const path = '/workspace-access';
const get = (w, id, cookie, headers = {}) => w.call(`${path}?request_id=${id}`, { headers: { cookie, ...headers } });
async function offer(w, person, options = {}) {
    const response = await w.start(person, options);
    assert.equal(response.status, 303, await response.clone().text());
    const url = new URL(response.headers.get('location'));
    assert.equal(url.origin, w.env.ISSUER);
    assert.equal(url.pathname, path);
    const browser = cookieJar(response);
    return { id: url.searchParams.get('request_id'), browser, cookie: jarOf(person.cookie, browser), csrf: person.csrf };
}
const reply = (w, flow, changes = {}, headers = {}) => w.form(path, { request_id: flow.id, csrf: flow.csrf, ...changes }, flow.cookie, headers);

test('workspace access names only the person’s eligible teams and shows instructions by role', async t => {
    const w = await joinWorld(t), member = await w.person(), outsider = await w.person('other@example.com');
    const brand = { name: 'Tasks', mark: 'c'.repeat(64), support_url: 'https://app.example.com/help', look: { palette: 'glacier' } };
    w.db.prepare("UPDATE clients SET branding=? WHERE id='other'").run(JSON.stringify(brand));
    addTeam(w.db, 'member-team', member.user.id, { role: 'member', name: 'Design <team>' });
    addTeam(w.db, 'unrelated', outsider.user.id, { name: 'Private workspace' });
    addTeam(w.db, 'closed', member.user.id, { status: 'closed' });
    addTeam(w.db, 'personal', member.user.id, { kind: 'personal' });
    const first = await offer(w, member);
    const page = await get(w, first.id, first.cookie), html = await page.text();
    assert.equal(page.status, 200);
    assertFireMarkup(html);
    assert.match(html, /Tasks isn’t in your workspace yet/);
    assert.match(html, /Ask an owner or admin of Design &lt;team&gt; to add Tasks\./);
    assert.match(html, /Signed in as owner@example\.com.*action="\/switch-account"/s);
    assert.match(html, /theme\.css\?client=other/);
    assert.match(html, new RegExp(brand.mark));
    assert.match(html, /data-palette="glacier"/);
    assert.equal((html.match(/data-variant="primary"/g) || []).length, 1);
    assert.doesNotMatch(html, /Private workspace|>closed<|>personal<|<script[^>]*src="\/fire\//);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/app\.example;/);
    addTeam(w.db, 'admin-team', member.user.id, { role: 'admin', name: 'Editorial' });
    for (let n = 0; n < 5; n++) addTeam(w.db, `viewer-${n}`, member.user.id, { role: 'viewer', name: `Team ${n}` });
    const many = await (await get(w, first.id, first.cookie)).text();
    assert.match(many, /Tasks isn’t in your workspaces yet/);
    assert.match(many, /Contact <a class="fd-link" href="https:\/\/app\.example\.com\/help">Tasks<\/a> to add it to Editorial/);
    assert.equal((many.match(/class="fd-list-row"/g) || []).length, 5);
    assert.doesNotMatch(many, /Team 4|Private workspace|data-interactive/);
});

test('workspace access requires the original browser and person, Origin and CSRF, and answers once', async t => {
    const w = await joinWorld(t), member = await w.person(), other = await w.person('other@example.com');
    addTeam(w.db, 'one', member.user.id, { role: 'member' });
    addTeam(w.db, 'two', other.user.id, { role: 'owner' });
    const flow = await offer(w, member);
    const foreign = await begin(w), otherCookie = jarOf(other.cookie, flow.browser);
    await error(await get(w, flow.id, jarOf(member.cookie, foreign.cookie)), 'browser_binding', 403);
    await error(await get(w, flow.id, otherCookie), 'access_denied', 403);
    await error(await reply(w, { ...flow, cookie: jarOf(member.cookie, foreign.cookie) }), 'browser_binding', 403);
    await error(await reply(w, { ...flow, cookie: otherCookie, csrf: other.csrf }), 'access_denied', 403);
    await error(await reply(w, flow, { csrf: '' }), 'csrf', 403);
    await error(await reply(w, flow, { csrf: 'wrong' }), 'csrf', 403);
    await error(await reply(w, flow, {}, { origin: 'https://other.example.com' }), 'origin', 403);
    const responses = await Promise.all([reply(w, flow), reply(w, flow)]);
    const success = responses.find(res => res.status === 303);
    assert.equal(responses.filter(res => res.status === 303).length, 1);
    const location = new URL(success.headers.get('location'));
    assert.equal(location.origin + location.pathname, 'https://app.example/callback');
    assert.deepEqual(Object.fromEntries(location.searchParams), { error: 'access_denied', state: 'rp-state', iss: w.env.ISSUER });
    assert.ok(responses.find(res => res !== success).status >= 400);
    await error(await reply(w, flow), 'browser_binding', 403);
    const expired = await offer(w, member);
    w.db.prepare('UPDATE auth_requests SET expires_at=0 WHERE id=?').run(expired.id);
    await error(await get(w, expired.id, expired.cookie), 'browser_binding', 403);
    await error(await reply(w, expired), 'browser_binding', 403);
    const removed = await offer(w, member);
    w.db.exec("DELETE FROM workspace_members WHERE workspace_id='one'");
    await error(await get(w, removed.id, removed.cookie), 'access_denied', 403);
    await error(await reply(w, removed), 'invalid_request');
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM codes').get().n, 0);
});

test('workspace access does not replace direct refusals for prompt=none, agents or people without a team', async t => {
    const w = await joinWorld(t), member = await w.person();
    const refusal = async options => {
        const url = new URL((await w.start(member, options)).headers.get('location'));
        assert.equal(url.searchParams.get('error'), 'access_denied');
    };
    await refusal();
    addTeam(w.db, 'personal', member.user.id, { kind: 'personal' });
    await refusal();
    addTeam(w.db, 'team', member.user.id, { role: 'member' });
    await refusal({ prompt: 'none' });
    const agent = await agentWorld(t);
    configureJoin(agent.env.DB.db, 'other', 'app');
    agent.env.DB.db.exec("UPDATE clients SET signup_policy='invited' WHERE id='app'");
    addTeam(agent.env.DB.db, 'team', agent.user.id, { role: 'member' });
    const flow = await agent.start();
    const request = new Request(agent.env.ISSUER + '/agent/consent', { headers: { cookie: flow.cookie } });
    await assert.rejects(completeAuthorization(agent.env, request, flow.id, agent.signed.session), { code: 'access_denied' });
    await error(await get(agent, flow.id, flow.cookie), 'access_denied', 403);
});
