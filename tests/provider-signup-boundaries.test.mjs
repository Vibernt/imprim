import assert from 'node:assert/strict';
import test from 'node:test';
import { challengeOf } from '../apps/server/src/lib/crypto.mjs';
import { adminLogin } from './support/admin.mjs';
import { fakeGoogle } from './support/google.mjs';
import { effectCounts, githubProfile, gmail, linkToken, locationOf, postSignup, providerCallback, startProvider, unchanged } from './support/provider-signup.mjs';
import { count, person, refused, signupWorld, verify } from './support/signup.mjs';
import { begin, cookieJar } from './support/world.mjs';

const appChange = (db, settings) => db.exec(`UPDATE clients SET ${settings} WHERE id='app'`);
const otherUser = db => db.exec("INSERT INTO users(id,email,email_verified,created) VALUES('other-user','other@example.com',1,0)");
const linkElsewhere = db => db.exec("INSERT INTO user_identities(provider,provider_id,user_id,created) VALUES('github','42','other-user',0)");

for (const method of ['google', 'github']) test(`${method} sign-up start checks Origin, browser, request id, method and rate limit`, async t => {
    const w = await signupWorld(t), flow = await begin(w), foreign = await begin(w);
    await refused(await postSignup(w, method, flow, {}, { origin: '' }), 403, 'origin');
    await refused(await postSignup(w, method, flow, {}, { origin: 'https://elsewhere.example.com' }), 403, 'origin');
    await refused(await postSignup(w, method, { ...flow, cookie: '' }), 403, 'browser_binding');
    await refused(await postSignup(w, method, { ...flow, cookie: foreign.cookie }), 403, 'browser_binding');
    await refused(await postSignup(w, method, { ...flow, request_id: 'unknown' }), 403, 'browser_binding');
    await refused(await postSignup(w, method, flow, { workspace_name: '🍃'.repeat(121) }), 400, 'invalid_request');
    await refused(await w.post(`/v1/auth/${method}/signup`, { request_id: flow.request_id }, flow.cookie), 415, 'invalid_request');
    await refused(await w.call(`/v1/auth/${method}/signup?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } }), 404, 'not_found');
    appChange(w.db, `sign_in_methods='["email"]'`);
    await refused(await postSignup(w, method, flow), 403, 'access_denied');
    appChange(w.db, `sign_in_methods='["email","${method}"]'`);
    w.db.prepare('UPDATE auth_requests SET expires_at=0 WHERE id=?').run(flow.request_id);
    await refused(await postSignup(w, method, flow), 403, 'browser_binding');
    const live = await begin(w);
    w.env.AUTH_LIMITER = { async limit() { return { success: false }; } };
    await refused(await postSignup(w, method, live), 429, 'rate_limit');
    assert.equal(count(w.db, 'oauth_states'), 0);
    unchanged(w.db);
});

for (const [gate, options, settings] of [
    ['realm off', { realmSignup: 'off' }], ['realm workspaces off', { realmWorkspaces: 'off' }],
    ['app off', { appSignup: 'off' }], ['private workspaces', { workspaces: 'app' }],
    ['missing product', {}, 'product=NULL'], ['no email method', {}, `sign_in_methods='["google","github"]'`]
]) test(`provider sign-up start refuses ${gate}`, async t => {
    const w = await signupWorld(t, options);
    if (settings) appChange(w.db, settings);
    const flow = await begin(w);
    for (const method of ['google', 'github']) await refused(await postSignup(w, method, flow), 403, 'access_denied');
    const page = await w.call('/login?request_id=' + flow.request_id + '&view=signup', { headers: { cookie: flow.cookie } });
    const html = await page.text();
    assert.match(html, /id="sign-in-head">/);
    assert.doesNotMatch(html, /data-signup-provider|id="signup-head"/);
    assert.equal(count(w.db, 'oauth_states'), 0);
    unchanged(w.db);
});

test('provider sign-up is unavailable to a valid agent authorization', async t => {
    const w = await signupWorld(t);
    appChange(w.db, `agent_access='on',agent_registration_methods='["dynamic"]',
        agent_scope_catalogue='{"read":"Read workspace"}',agent_resource_prefixes='["https://app.example.com/"]'`);
    const redirect_uri = 'http://127.0.0.1:4567/callback';
    const registration = await w.post('/register', { client_name: 'Test agent', redirect_uris: [redirect_uri] });
    assert.equal(registration.status, 201, await registration.clone().text());
    const { client_id } = await registration.json();
    const params = new URLSearchParams({ client_id, app_id: 'app', resource: 'https://app.example.com/mcp', redirect_uri,
        scope: 'read', state: 'agent-state', response_type: 'code', code_challenge: await challengeOf(w.verifier), code_challenge_method: 'S256' });
    const authorization = await w.call('/authorize?' + params);
    assert.equal(authorization.status, 200, await authorization.clone().text());
    const html = await authorization.text();
    assert.doesNotMatch(html, /data-signup-provider/);
    const flow = { request_id: html.match(/data-request-id="([^"]+)"/)[1], cookie: cookieJar(authorization) };
    await refused(await postSignup(w, 'github', flow), 403, 'access_denied');
    assert.equal(count(w.db, 'oauth_states'), 0);
    unchanged(w.db);
});

test('provider signup POST keeps a configured-provider failure explicit', async t => {
    const w = await signupWorld(t), flow = await begin(w);
    w.db.exec("UPDATE realms SET config=json_remove(config,'$.github')");
    delete w.env.GITHUB_CLIENT_ID;
    delete w.env.GITHUB_CLIENT_SECRET;
    await refused(await postSignup(w, 'github', flow), 503, 'github_config');
    assert.equal(count(w.db, 'oauth_states'), 0);
    unchanged(w.db);
});

test('Google hosted-domain restriction rejects even Gmail mailbox proof', async t => {
    const w = await signupWorld(t), google = fakeGoogle(t, w, { email: gmail, hd: undefined });
    appChange(w.db, `google_hosted_domains='["example.com"]'`);
    await refused(await providerCallback(w, await startProvider(w, 'google', { google })), 403, 'access_denied');
    unchanged(w.db);
});

test('provider signup state cannot be claimed by another authorization browser or used after expiry', async t => {
    const w = await signupWorld(t), calls = githubProfile(t, w);
    const foreign = await begin(w), flow = await startProvider(w, 'github');
    const nonce = cookieJar(flow.response);
    await refused(await providerCallback(w, flow, { cookie: foreign.cookie + '; ' + nonce }), 401, 'invalid_grant');
    assert.equal(count(w.db, 'oauth_states'), 1);
    const wrongProvider = { ...flow, method: 'google' };
    await refused(await providerCallback(w, wrongProvider, { cookie: flow.cookie + '; ' + nonce.replace('__Host-vi_oauth=', '__Host-vi_google=') }), 401, 'invalid_grant');
    w.db.exec('UPDATE oauth_states SET expires_at=0');
    await refused(await providerCallback(w, flow), 401, 'invalid_grant');
    assert.deepEqual(calls, []);
    unchanged(w.db);
});

test('concurrent sign-up callbacks spend one state and issue one link', async t => {
    const w = await signupWorld(t), calls = githubProfile(t, w);
    const flow = await startProvider(w, 'github');
    const responses = await Promise.all([providerCallback(w, flow), providerCallback(w, flow)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [303, 401]);
    assert.equal(calls.length, 3);
    assert.equal(w.mails.length, 1);
    assert.equal(count(w.db, 'magic_links'), 1);
});

for (const [name, sql] of [
    ['realm turned off', "UPDATE realms SET config=json_set(config,'$.signup','off')"],
    ['app turned off', "UPDATE clients SET self_signup='off' WHERE id='app'"],
    ['provider removed', `UPDATE clients SET sign_in_methods='["email","google"]' WHERE id='app'`]
]) test(`provider signup re-reads policy after provider I/O when ${name}`, async t => {
    const w = await signupWorld(t);
    githubProfile(t, w, { beforeProfile: () => w.db.exec(sql) });
    await refused(await providerCallback(w, await startProvider(w, 'github')), 403, 'access_denied');
    assert.equal(w.mails.length, 0);
    unchanged(w.db);
});

for (const mode of ['open', 'approval']) test(`a pending provider link refuses an identity claimed elsewhere before ${mode} verification`, async t => {
    const w = await signupWorld(t, { realmSignup: mode });
    githubProfile(t, w);
    const flow = await startProvider(w, 'github');
    assert.equal(locationOf(await providerCallback(w, flow)).pathname, '/check-email');
    const foreign = await begin(w);
    const minted = { ...flow, token: linkToken(w) };
    await refused(await verify(w, minted, {}, { origin: 'https://elsewhere.example.com' }), 403, 'origin');
    await refused(await verify(w, { ...minted, cookie: foreign.cookie }), 401, 'invalid_grant');
    assert.equal(count(w.db, 'magic_links'), 1);
    otherUser(w.db);
    linkElsewhere(w.db);
    const before = effectCounts(w.db);
    const response = await verify(w, minted);
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).error_description, 'This provider is linked to another account.');
    unchanged(w.db, { ...before, magic_links: 0 });
    assert.equal(w.db.prepare('SELECT user_id FROM user_identities').get().user_id, 'other-user');
    await refused(await verify(w, minted), 401, 'invalid_grant');
});

test('approval persists but skips a provider id claimed after mailbox proof', async t => {
    const w = await signupWorld(t, { realmSignup: 'approval' });
    githubProfile(t, w);
    const flow = await startProvider(w, 'github');
    assert.equal(locationOf(await providerCallback(w, flow)).pathname, '/check-email');
    assert.equal(locationOf(await verify(w, { ...flow, token: linkToken(w) })).pathname, '/signup-pending');
    const { id } = w.db.prepare('SELECT id FROM signup_requests').get();
    await w.drain();
    otherUser(w.db);
    linkElsewhere(w.db);
    const admin = await adminLogin(w);
    const endpoint = `signups/${id}/approve`;
    await refused(await admin.post(endpoint, {}, { 'x-csrf-token': 'wrong' }), 403, 'csrf');
    await refused(await admin.post(endpoint, {}, { origin: 'https://elsewhere.example.com' }), 403, 'origin');
    assert.equal(count(w.db, 'workspaces'), 0);
    const approved = await admin.post(endpoint);
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.equal((await approved.json()).status, 'approved');
    assert.equal(w.db.prepare('SELECT user_id FROM user_identities').get().user_id, 'other-user');
    assert.equal(w.db.prepare('SELECT email_verified FROM users WHERE email=?').get(person).email_verified, 1);
    assert.equal(count(w.db, 'workspaces'), 1);
    const detail = JSON.parse(w.db.prepare("SELECT detail FROM audit WHERE event='workspace_signup'").get().detail);
    assert.equal(detail.provider_link_skipped, true);
    assert.equal(detail.method, 'github');
});

for (const reason of ['claimed provider id', 'blocked', 'merged', 'deleted-and-merged']) {
    test(`${reason} refuses provider sign-up and never shows the no-account page`, async t => {
        const w = await signupWorld(t);
        githubProfile(t, w);
        otherUser(w.db);
        if (reason === 'claimed provider id') linkElsewhere(w.db);
        else w.db.prepare('INSERT INTO users(id,email,status,merged_into,created) VALUES(?,?,?,?,0)').run('affected', person,
            reason === 'blocked' ? 'blocked' : reason === 'merged' ? 'active' : 'deleted', reason === 'blocked' ? null : 'other-user');
        const before = effectCounts(w.db);
        for (const signup of [true, false]) {
            const response = await providerCallback(w, await startProvider(w, 'github', { signup }), { accept: 'text/html' });
            assert.equal(response.status, 403);
            const html = await response.text();
            assert.match(html, /Account unavailable\./);
            assert.doesNotMatch(html, /No Notes account|person@example\.com/);
            unchanged(w.db, before);
        }
        assert.equal(w.mails.length, 0);
    });
}

test('ownership limit and subject hints refuse a provider signup before its side effects', async t => {
    const w = await signupWorld(t), google = fakeGoogle(t, w, { email: gmail, hd: undefined });
    otherUser(w.db);
    let flow = await begin(w);
    w.db.prepare("UPDATE auth_requests SET hint_sub='other-user' WHERE id=?").run(flow.request_id);
    const before = effectCounts(w.db);
    await refused(await providerCallback(w, await startProvider(w, 'google', { flow, google })), 401, 'login_required');
    unchanged(w.db, before);
    githubProfile(t, w);
    flow = await begin(w);
    w.db.prepare("UPDATE auth_requests SET hint_sub='other-user' WHERE id=?").run(flow.request_id);
    await refused(await providerCallback(w, await startProvider(w, 'github', { flow })), 401, 'login_required');
    unchanged(w.db, before);
    w.db.exec(`INSERT INTO users(id,email,created) VALUES('owner','person@example.com',0);
        INSERT INTO workspaces(id,realm_id,kind,name,created,created_via,status) VALUES('closed','default','team','Old team',0,'signup','closed');
        INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('closed','owner','owner',0,0);
        INSERT INTO workspace_products(workspace_id,product,created) VALUES('closed','notes',0);`);
    const owned = effectCounts(w.db);
    await refused(await providerCallback(w, await startProvider(w, 'github')), 409, 'signup_limit');
    unchanged(w.db, owned);
    assert.equal(w.mails.length, 0);
});

test('provider email delivery failure deletes the link and the per-address email budget still applies', async t => {
    const w = await signupWorld(t);
    githubProfile(t, w);
    w.env.EMAIL.send = async () => { throw new Error('Email service refused the message'); };
    await refused(await providerCallback(w, await startProvider(w, 'github')), 500, 'server_error');
    unchanged(w.db);
    w.db.exec('UPDATE rate_limits SET count=5');
    await refused(await providerCallback(w, await startProvider(w, 'github')), 429, 'rate_limit');
    unchanged(w.db);
});

test('a provider link stops if the provider is removed before mailbox verification', async t => {
    const w = await signupWorld(t);
    githubProfile(t, w);
    const flow = await startProvider(w, 'github');
    assert.equal(locationOf(await providerCallback(w, flow)).pathname, '/check-email');
    appChange(w.db, `sign_in_methods='["email","google"]'`);
    await refused(await verify(w, { ...flow, token: linkToken(w) }), 403, 'access_denied');
    unchanged(w.db);
});

test('an outbox failure rolls back the workspace and provider link together', async t => {
    const w = await signupWorld(t), google = fakeGoogle(t, w, { email: gmail, hd: undefined });
    const flow = await startProvider(w, 'google', { google });
    w.db.exec(`CREATE TRIGGER reject_signup_event BEFORE INSERT ON workspace_event_outbox
        BEGIN SELECT RAISE(ABORT,'test event failure'); END`);
    await refused(await providerCallback(w, flow), 500, 'server_error');
    unchanged(w.db);
    await refused(await providerCallback(w, flow), 401, 'invalid_grant');
});
