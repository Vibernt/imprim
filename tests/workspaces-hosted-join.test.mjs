import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFireMarkup, enrolMfa } from './support/admin.mjs';
import { agentWorld, error } from './support/agents.mjs';
import { addTeam, configureJoin, joinWorld, joinPath } from './support/workspace-join.mjs';
import { basic, begin, turnstile, cookieJar } from './support/world.mjs';
import { completeAuthorization } from '../apps/server/src/oidc/requests.mjs';

const location = response => new URL(response.headers.get('location'));

test('hosted join lists eligible teams, joins a product and admits the owner and another member', async t => {
    const w = await joinWorld(t), owner = await w.person(), member = await w.person('member@example.com');
    const logo = 'a'.repeat(64);
    w.db.prepare("UPDATE clients SET branding=? WHERE id='other'").run(JSON.stringify({ name: 'Tasks <HQ>', logo_light: logo }));
    addTeam(w.db, 'team', owner.user.id, { name: 'Alpha <Team>' });
    addTeam(w.db, 'second', owner.user.id, { name: 'Beta', product: 'files' });
    addTeam(w.db, 'closed', owner.user.id, { status: 'closed' });
    addTeam(w.db, 'personal', owner.user.id, { kind: 'personal' });
    addTeam(w.db, 'admin-only', owner.user.id, { role: 'admin' });
    addTeam(w.db, 'someone-elses', member.user.id);
    w.db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('team',?,'member',0,0)").run(member.user.id);
    const flow = await w.offer(owner);
    const page = await w.call(flow.path, { headers: { cookie: flow.cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/app\.example;/);
    const html = await page.text();
    assertFireMarkup(html);
    assert.doesNotMatch(html, /<script[^>]*src="(?!\/imprim\/head\.js")|\bchecked\b|admin-only|someone-elses/);
    assert.match(html, /Use a workspace for Tasks &lt;HQ&gt;/);
    assert.match(html, new RegExp('/assets/brand/' + logo));
    assert.match(html, /Alpha &lt;Team&gt;[\s\S]*>notes<.*>Beta<[\s\S]*>files</);
    assert.deepEqual([...html.matchAll(/name="workspace_id" value="([^"]+)"/g)].map(match => match[1]), ['team', 'second']);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM client_admissions').get().n, 0);

    const joined = await w.answer(flow);
    assert.equal(joined.status, 303, await joined.clone().text());
    const redirect = location(joined);
    assert.equal(redirect.origin + redirect.pathname, 'https://app.example/callback');
    assert.equal(redirect.searchParams.get('state'), 'rp-state');
    assert.equal(redirect.searchParams.get('iss'), w.env.ISSUER);
    const tokenResponse = await w.exchange(redirect.searchParams.get('code'), {}, basic('other'));
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    const tokens = await tokenResponse.json();
    await error(await w.post('/v1/workspaces/team/products', {
        actor_token: tokens.id_token, add: [], remove: ['tasks']
    }, '', { authorization: basic('other') }), 'access_denied', 403);
    assert.equal(w.productCount(), 1);
    assert.equal(w.db.prepare("SELECT version FROM workspaces WHERE id='team'").get().version, 2);
    const events = w.db.prepare("SELECT client_id,event,payload FROM workspace_event_outbox WHERE workspace_id='team' ORDER BY client_id").all();
    assert.deepEqual(events.map(row => [row.client_id, row.event, JSON.parse(row.payload)]), ['app', 'other'].map(id =>
        [id, 'workspace-products-changed', { workspace_id: 'team', version: 2, products: ['notes', 'tasks'] }]));
    const audit = w.db.prepare("SELECT actor,detail FROM audit WHERE event='workspace-products-changed'").get();
    assert.equal(audit.actor, owner.user.id);
    assert.deepEqual(JSON.parse(audit.detail), { add: ['tasks'], remove: [], via: 'sign_in', client_id: 'other', version: 2 });
    await error(await w.answer(flow), 'browser_binding', 403);
    const memberSignIn = await w.start(member);
    assert.ok(location(memberSignIn).searchParams.get('code'));
    assert.deepEqual(w.db.prepare("SELECT source FROM client_admissions WHERE client_id='other'").all().map(row => row.source),
        ['workspace', 'workspace']);
});

test('hosted join limits the ordered choice list to 20 and localizes a single preselected workspace', async t => {
    const w = await joinWorld(t), owner = await w.person();
    addTeam(w.db, 'team', owner.user.id);
    const single = await w.offer(owner, { ui_locales: 'es' });
    const html = await (await w.call(single.path, { headers: { cookie: single.cookie } })).text();
    assert.match(html, /name="workspace_id" value="team" checked required/);
    assert.match(html, /lang="es"/);
    assert.match(html, /Usar este espacio de trabajo/);
    for (let i = 25; i >= 1; i--) addTeam(w.db, 'id-' + i, owner.user.id, { name: String(i).padStart(2, '0') });
    const many = await w.offer(owner);
    const htmlMany = await (await w.call(many.path, { headers: { cookie: many.cookie } })).text();
    assert.deepEqual([...htmlMany.matchAll(/name="workspace_id" value="([^"]+)"/g)].map(match => match[1]),
        Array.from({ length: 20 }, (_, i) => 'id-' + (i + 1)));
    await error(await w.answer(many, { workspace_id: 'id-21' }), 'not_found', 404);
});

test('ordinary refusals and already-admitted authorization do not offer hosted join', async t => {
    const w = await joinWorld(t), owner = await w.person();
    const refusal = async (person = owner, query = {}) => {
        const target = location(await w.start(person, query));
        assert.equal(target.origin, 'https://app.example');
        assert.equal(target.searchParams.get('error'), 'access_denied');
    };
    for (const role of ['admin', 'member']) addTeam(w.db, role, owner.user.id, { role });
    addTeam(w.db, 'closed', owner.user.id, { status: 'closed' });
    addTeam(w.db, 'personal', owner.user.id, { kind: 'personal' });
    await refusal();
    addTeam(w.db, 'team', owner.user.id);
    w.db.exec("UPDATE clients SET join_workspaces='off' WHERE id='other'");
    await refusal();
    w.db.exec("UPDATE clients SET join_workspaces='on' WHERE id='other'");
    await refusal(owner, { prompt: 'none' });
    w.db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','off')");
    await refusal();
    w.db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','on')");
    w.db.prepare("INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,'other',0,'app')").run(owner.user.id);
    assert.ok(location(await w.start(owner)).searchParams.get('code'));
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM auth_requests WHERE workspace_join IS NOT NULL').get().n, 0);
});

test('completeAuthorization keeps refusing unadmitted agent requests even when the app accepts hosted joins', async t => {
    const w = await agentWorld(t), db = w.env.DB.db;
    configureJoin(db, 'other', 'app');
    db.exec("UPDATE clients SET signup_policy='invited' WHERE id='app'");
    addTeam(db, 'team', w.user.id);
    const flow = await w.start();
    const request = new Request(w.env.ISSUER + '/agent/consent', { headers: { cookie: flow.cookie } });
    await assert.rejects(completeAuthorization(w.env, request, flow.id, w.signed.session), { code: 'access_denied' });
    assert.equal(db.prepare('SELECT workspace_join FROM auth_requests WHERE id=?').get(flow.id).workspace_join, null);
});

test('a fresh email-link sign-in can reach the hosted step without creating an app admission', async t => {
    const w = await joinWorld(t), owner = await w.person();
    addTeam(w.db, 'team', owner.user.id);
    turnstile(t);
    const flow = await begin(w, '', { client_id: 'other', prompt: 'login' });
    const send = email => w.post('/v1/auth/magic/request', { request_id: flow.request_id, email, turnstile: crypto.randomUUID() }, flow.cookie);
    assert.equal((await send('stranger@example.com')).status, 200);
    await w.drain();
    assert.equal(w.mails.length, 0);
    assert.equal((await send(owner.user.email)).status, 200);
    await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const signed = await w.post('/v1/auth/magic/verify', { token }, flow.cookie);
    assert.equal(signed.status, 303, await signed.clone().text());
    const url = location(signed);
    assert.equal(url.pathname, joinPath);
    assert.equal(url.searchParams.get('request_id'), flow.request_id);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM client_admissions').get().n, 0);
    assert.equal((await w.call(url.pathname + url.search, { headers: { cookie: flow.cookie + '; ' + cookieJar(signed) } })).status, 200);
});

test('a hosted join resumes the same request through the normal MFA challenge before issuing a code', async t => {
    const w = await joinWorld(t), owner = await w.person();
    addTeam(w.db, 'team', owner.user.id);
    const mfa = await enrolMfa(w, owner.cookie, owner.csrf);
    w.db.exec("UPDATE sessions SET mfa_at=NULL; UPDATE clients SET mfa='required' WHERE id='other'");
    const flow = await w.offer(owner), joined = await w.answer(flow);
    assert.equal(joined.status, 303, await joined.clone().text());
    assert.equal(location(joined).pathname, '/mfa');
    assert.equal(location(joined).searchParams.get('request_id'), flow.id);
    assert.equal(w.db.prepare('SELECT count(*) AS n FROM codes').get().n, 0);
    await error(await w.answer(flow, { action: 'decline' }), 'access_denied', 403);
    const verified = await w.form('/mfa', { request_id: flow.id, csrf: flow.csrf, code: mfa.recovery[0] }, flow.cookie);
    assert.equal(verified.status, 303, await verified.clone().text());
    assert.ok(location(verified).searchParams.get('code'));
});
