import assert from 'node:assert/strict';
import test from 'node:test';
import { adminLogin } from './support/admin.mjs';
import { fakeGoogle } from './support/google.mjs';
import { effectCounts, githubProfile, gmail, linkToken, locationOf, providerCallback, providerId, startProvider, unchanged } from './support/provider-signup.mjs';
import { count, person, signupWorld, verify } from './support/signup.mjs';
import { addTeam, configureJoin, joinPath } from './support/workspace-join.mjs';
import { begin } from './support/world.mjs';

const auditDetail = (db, event) => JSON.parse(db.prepare('SELECT detail FROM audit WHERE event=? ORDER BY rowid DESC LIMIT 1').get(event).detail);

async function assertSigned(w, response, method, user) {
    assert.equal(response.status, 303, await response.clone().text());
    const code = locationOf(response).searchParams.get('code');
    assert.ok(code);
    const exchange = await w.exchange(code);
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const { id_token } = await exchange.json();
    const claims = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url'));
    assert.equal(claims.sub, user.id);
    assert.equal(claims.email_verified, true);
    assert.deepEqual(claims.amr, [method]);
    assert.equal(w.db.prepare('SELECT method FROM sessions WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(user.id).method, method);
    assert.equal(auditDetail(w.db, 'sign_in').method, method);
}

function assertCreated(w, { email, provider, name = 'Provider team' }) {
    const user = w.db.prepare('SELECT * FROM users WHERE email=?').get(email);
    assert.equal(user?.email_verified, 1);
    const team = w.db.prepare("SELECT * FROM workspaces WHERE created_via='signup'").get();
    assert.equal(team?.name, name);
    assert.deepEqual({ ...w.db.prepare('SELECT user_id,role FROM workspace_members WHERE workspace_id=?').get(team.id) },
        { user_id: user.id, role: 'owner' });
    assert.equal(w.db.prepare('SELECT product FROM workspace_products WHERE workspace_id=?').get(team.id).product, 'notes');
    assert.equal(w.db.prepare("SELECT source FROM client_admissions WHERE client_id='app' AND user_id=?").get(user.id).source, 'workspace');
    const identity = w.db.prepare('SELECT * FROM user_identities WHERE user_id=?').get(user.id);
    assert.deepEqual([identity?.provider, identity?.provider_id, identity?.login], [provider, providerId[provider], provider === 'github' ? 'person' : null]);
    assert.equal(auditDetail(w.db, 'workspace_signup').method, provider);
    return user;
}

for (const [label, email, hd] of [['Gmail', gmail, undefined], ['hosted domain', person, 'example.com']]) {
    test(`Google ${label} open sign-up proves the mailbox and atomically links the verified workspace owner`, async t => {
        const w = await signupWorld(t);
        const google = fakeGoogle(t, w, { email, hd });
        const flow = await startProvider(w, 'google', { google, fields: { workspace_name: '  Provider team ' } });
        const state = w.db.prepare('SELECT purpose, workspace_name FROM oauth_states').get();
        assert.deepEqual({ ...state }, { purpose: 'signup', workspace_name: 'Provider team' });
        unchanged(w.db);
        const response = await providerCallback(w, flow);
        const user = assertCreated(w, { email, provider: 'google' });
        await assertSigned(w, response, 'google', user);
        assert.equal(w.db.prepare('SELECT google_hd FROM sessions').get().google_hd, hd ?? null);
        assert.equal(w.mails.length, 0);
    });
}

for (const provider of ['github', 'google']) {
    test(`${provider} provider proof waits for the original browser to verify the email; next provider sign-in works`, async t => {
        const w = await signupWorld(t, { botCheck: true });
        const google = provider === 'google' ? fakeGoogle(t, w, { hd: undefined }) : undefined;
        if (!google) githubProfile(t, w);
        const flow = await startProvider(w, provider, { google, fields: { workspace_name: ' Provider team ' } });
        const before = effectCounts(w.db);
        const response = await providerCallback(w, flow);
        assert.equal(response.status, 303, await response.clone().text());
        assert.equal(locationOf(response).pathname, '/check-email');
        assert.equal(locationOf(response).searchParams.get('request_id'), flow.request_id);
        assert.match(response.headers.get('set-cookie'), /__Host-vi_check_email=/);
        assert.doesNotMatch(response.headers.get('set-cookie'), /__Host-vi_session=/);
        unchanged(w.db, { ...before, magic_links: 1 });
        const link = w.db.prepare('SELECT * FROM magic_links').get();
        assert.deepEqual([link.purpose, link.email, link.workspace_name, link.provider, link.provider_id], ['signup', person, 'Provider team', provider, providerId[provider]]);
        assert.equal(w.mails.at(-1).subject, 'Create an account for Notes');
        assert.equal((await providerCallback(w, flow)).status, 401);
        const verified = await verify(w, { ...flow, token: linkToken(w) });
        assert.equal(verified.status, 303, await verified.clone().text());
        const user = assertCreated(w, { email: person, provider });
        await assertSigned(w, verified, 'email', user);
        assert.equal(count(w.db, 'magic_links'), 0);
        const signed = await providerCallback(w, await startProvider(w, provider, { google, signup: false }));
        await assertSigned(w, signed, provider, user);
        assert.equal(count(w.db, 'workspaces'), 1);
    });
}

for (const provider of ['google', 'github']) {
    test(`${provider} approval stores the provider and approval links it for the next sign-in`, async t => {
        const w = await signupWorld(t, { realmSignup: 'approval' }), email = provider === 'google' ? gmail : person;
        const google = provider === 'google' ? fakeGoogle(t, w, { email, hd: undefined }) : undefined;
        if (!google) githubProfile(t, w);
        const flow = await startProvider(w, provider, { google, fields: { workspace_name: 'Provider team' } });
        const before = effectCounts(w.db);
        let response = await providerCallback(w, flow);
        if (provider === 'github') {
            assert.equal(locationOf(response).pathname, '/check-email');
            unchanged(w.db, { ...before, magic_links: 1 });
            response = await verify(w, { ...flow, token: linkToken(w) });
        }
        assert.equal(response.status, 303, await response.clone().text());
        assert.equal(locationOf(response).pathname, '/signup-pending');
        const pending = await w.call(locationOf(response).pathname + locationOf(response).search, { headers: { cookie: flow.cookie } });
        assert.match(await pending.text(), /Your request is waiting for approval/);
        unchanged(w.db, { ...before, signup_requests: 1 });
        await w.drain();
        assert.match(w.mails.at(-1).text, new RegExp('Sign-up method: ' + (google ? 'Google' : 'GitHub')));
        const signup = w.db.prepare('SELECT * FROM signup_requests').get();
        assert.deepEqual([signup.email, signup.provider, signup.provider_id, signup.provider_login],
            [email, provider, providerId[provider], google ? null : 'person']);

        const admin = await adminLogin(w);
        const listed = (await (await admin.get('signups')).json()).requests[0];
        assert.equal(listed.provider, provider);
        assert.equal(Object.hasOwn(listed, 'provider_id'), false);
        const approved = await admin.post(`signups/${signup.id}/approve`);
        assert.equal(approved.status, 200, await approved.clone().text());
        assert.equal((await approved.json()).status, 'approved');
        const user = assertCreated(w, { email, provider });
        const signed = await providerCallback(w, await startProvider(w, provider, { google, signup: false }));
        await assertSigned(w, signed, provider, user);
    });
}

test('an already admitted, linked applicant signs in without a new workspace or email', async t => {
    const w = await signupWorld(t);
    githubProfile(t, w);
    w.db.exec(`INSERT INTO users(id,email,email_verified,created) VALUES('member','person@example.com',1,0);
        INSERT INTO user_identities(provider,provider_id,user_id,created) VALUES('github','42','member',0);
        INSERT INTO client_admissions(user_id,client_id,created) VALUES('member','app',0);`);
    const response = await providerCallback(w, await startProvider(w, 'github'));
    await assertSigned(w, response, 'github', { id: 'member' });
    assert.equal(count(w.db, 'users'), 1);
    assert.equal(count(w.db, 'workspaces'), 0);
    assert.equal(count(w.db, 'signup_requests'), 0);
    assert.equal(w.mails.length, 0);
});

test('provider sign-up uses the ordinary workspace join path for an eligible owner', async t => {
    const w = await signupWorld(t);
    githubProfile(t, w);
    configureJoin(w.db, 'other', 'app');
    w.db.exec(`INSERT INTO users(id,email,email_verified,created) VALUES('owner','person@example.com',1,0);
        INSERT INTO user_identities(provider,provider_id,user_id,created) VALUES('github','42','owner',0);`);
    addTeam(w.db, 'team', 'owner');
    const response = await providerCallback(w, await startProvider(w, 'github', { flow: await begin(w) }));
    assert.equal(response.status, 303, await response.clone().text());
    assert.equal(locationOf(response).pathname, joinPath);
    assert.equal(count(w.db, 'workspaces'), 1);
    assert.equal(count(w.db, 'client_admissions'), 0);
    assert.equal(w.mails.length, 0);
});

test('an open app still requires mailbox proof before a weak provider signup can provision a user', async t => {
    const w = await signupWorld(t, { realmSignup: 'approval' });
    githubProfile(t, w);
    w.db.exec("UPDATE clients SET signup_policy='open' WHERE id='app'");
    const flow = await startProvider(w, 'github');
    const before = effectCounts(w.db);
    const response = await providerCallback(w, flow);
    assert.equal(locationOf(response).pathname, '/check-email');
    unchanged(w.db, { ...before, magic_links: 1 });
    const verified = await verify(w, { ...flow, token: linkToken(w) });
    const user = w.db.prepare('SELECT * FROM users WHERE email=?').get(person);
    assert.equal(user?.email_verified, 1);
    await assertSigned(w, verified, 'email', user);
    assert.equal(w.db.prepare('SELECT user_id FROM user_identities').get().user_id, user.id);
    assert.equal(count(w.db, 'workspaces'), 0);
    assert.equal(count(w.db, 'signup_requests'), 0);
});
