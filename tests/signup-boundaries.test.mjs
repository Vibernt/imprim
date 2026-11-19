import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetRealms } from '../apps/server/src/realms/realm.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { begin, cookieJar, turnstile } from './support/world.mjs';
import { ask, count, invite, mint, person, refused, signupWorld, verify } from './support/signup.mjs';

for (const [name, settings] of [
    ['realm sign-up is off', { realmSignup: 'off' }],
    ['realm workspaces are off', { realmWorkspaces: 'off' }],
    ['app sign-up is off', { appSignup: 'off' }],
    ['app workspaces are not shared', { workspaces: 'app' }],
    ['app has no product', { product: null }],
    ['app disables email links', { methods: ['github'] }]
]) {
    test(`sign-up is unavailable when ${name}`, async t => {
        const w = await signupWorld(t, settings);
        if (Object.hasOwn(settings, 'product')) w.db.exec("UPDATE clients SET product=NULL WHERE id='app'");
        if (settings.methods) w.db.prepare("UPDATE clients SET sign_in_methods=? WHERE id='app'").run(JSON.stringify(settings.methods));
        const response = await w.authorize(), html = await response.text();
        const flow = { request_id: html.match(/data-request-id="([^"]+)"/)[1], cookie: cookieJar(response) };
        assert.doesNotMatch(html, /id="open-signup"/);
        await refused(await ask(w, flow), 403, 'access_denied');
        assert.equal(count(w.db, 'magic_links'), 0);
        assert.equal(w.mails.length, 0);
    });
}

test('hosted sign-up uses Fire, app branding and the authorization language', async t => {
    const w = await signupWorld(t, { botCheck: true });
    const response = await w.authorize({ ui_locales: 'fr' });
    const html = await response.text();
    const id = html.match(/data-request-id="([^"]+)"/)[1];
    assert.match(html, /<html lang="fr"/);
    assert.match(html, /id="open-signup"[^>]*>Créer un compte/);
    assert.match(html, /class="fd-field-label" for="workspace-name">Nom de l’espace de travail/);
    assert.match(html, /id="workspace-name"[^>]*name="workspace_name"/);
    assert.match(html, /data-sitekey="test-site-key" data-action="sign_in"/);
    assert.match(html, /Notes/);
    assert.doesNotMatch(html, /<style|\sstyle=|\/fire\/js\//);
    const check = await w.call('/check-email?request_id=' + id, { headers: { cookie: cookieJar(response) } });
    assert.match(await check.text(), /Consultez vos e-mails[\s\S]*Notes/);
    assert.equal((await w.call('/check-email?request_id=' + id)).status, 403);
    assert.doesNotMatch(await (await w.call('/login')).text(), /id="open-signup"/);
});

test('sign-up initiation requires Origin and the original browser authorization request', async t => {
    const w = await signupWorld(t), flow = await begin(w), foreign = await begin(w);
    await refused(await ask(w, flow, person, {}, { origin: 'https://app.example' }), 403, 'origin');
    await refused(await ask(w, { ...flow, cookie: foreign.cookie }), 403, 'browser_binding');
    await refused(await ask(w, { ...flow, request_id: undefined }), 403, 'access_denied');
    w.db.prepare("UPDATE auth_requests SET agent_client_id='agent_test' WHERE id=?").run(flow.request_id);
    assert.ok((await ask(w, flow)).status >= 400, 'agent request cannot start sign-up');
    assert.equal(w.mails.length, 0);
    assert.equal(count(w.db, 'magic_links'), 0);
});

test('redemption requires Origin and the original browser and refuses used and expired tokens', async t => {
    const w = await signupWorld(t), flow = await mint(w), foreign = await begin(w);
    await refused(await verify(w, flow, {}, { origin: 'https://app.example' }), 403, 'origin');
    await refused(await verify(w, { ...flow, cookie: foreign.cookie }), 401, 'invalid_grant');
    assert.equal(count(w.db, 'users'), 0);
    assert.equal(count(w.db, 'magic_links'), 1);
    assert.equal((await verify(w, flow)).status, 303);
    await refused(await verify(w, flow), 401, 'invalid_grant');
    const expired = await mint(w, { email: 'expired@example.com' });
    w.db.exec("UPDATE magic_links SET expires_at=0 WHERE email='expired@example.com'");
    await refused(await verify(w, expired), 401, 'invalid_grant');
    assert.equal(count(w.db, 'users'), 1);
    assert.equal(count(w.db, 'workspaces'), 1);
});

test('a live toggle or a new invitation fences an already issued signup link', async t => {
    const w = await signupWorld(t), { db } = w;
    const appOff = await mint(w);
    db.exec("UPDATE clients SET self_signup='off' WHERE id='app'");
    await refused(await verify(w, appOff), 403, 'access_denied');
    db.exec("UPDATE clients SET self_signup='on' WHERE id='app'");
    const realmOff = await mint(w);
    db.exec("UPDATE realms SET config=json_set(config,'$.signup','off')");
    assert.doesNotMatch(await (await w.authorize()).text(), /id="open-signup"/);
    await refused(await ask(w, realmOff), 403, 'access_denied');
    // Exercise the transactional realm guard while the request isolate still has the old realm bindings.
    await refused(await verify(w, realmOff), 403, 'access_denied');
    db.exec("UPDATE realms SET config=json_set(config,'$.signup','open')");
    forgetRealms(w.env);
    const invited = await mint(w);
    invite(db);
    await refused(await verify(w, invited), 409, 'conflict');
    assert.equal(count(db, 'users'), 0);
    assert.equal(count(db, 'workspace_members'), 0);
    assert.equal(count(db, 'client_admissions'), 0);
    const ordinary = await mint(w);
    assert.equal(ordinary.mail.subject, 'Sign in to Notes');
    assert.equal((await verify(w, ordinary)).status, 303);
    assert.ok(db.prepare("SELECT accepted_by FROM workspace_invitations WHERE id='invite'").get().accepted_by);
});

test('blocked accounts and an OIDC request bound to a different subject cannot create a workspace', async t => {
    const w = await signupWorld(t), { db } = w;
    const flow = await mint(w);
    const blocked = await ensureUser(w.env, person);
    db.prepare("UPDATE users SET status='blocked' WHERE id=?").run(blocked.id);
    await refused(await verify(w, flow), 403, 'access_denied');
    const response = await ask(w, await begin(w));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
    await w.drain();
    assert.equal(w.mails.length, 1);

    const hinted = await mint(w, { email: 'another@example.com' });
    db.prepare('UPDATE auth_requests SET hint_sub=? WHERE id=?').run(blocked.id, hinted.request_id);
    await refused(await verify(w, hinted), 401, 'login_required');
    assert.equal(count(db, 'users'), 1);
    for (const table of ['workspaces', 'workspace_members', 'client_admissions', 'sessions']) assert.equal(count(db, table), 0);
});

test('sign-up does not use an invitation from a different product and validates the optional name', async t => {
    const w = await signupWorld(t), { db } = w;
    invite(db, person, 'tasks');
    const flow = await begin(w);
    for (const workspace_name of [null, 23, 'a'.repeat(121), '🌱'.repeat(121), 'abc\0def'])
        await refused(await ask(w, flow, person, { workspace_name }), 400, 'invalid_request');
    assert.equal(w.mails.length, 0);
    const signup = await mint(w, { fields: { workspace_name: '  ' } });
    assert.equal(signup.mail.subject, 'Create an account for Notes');
    assert.equal((await verify(w, signup)).status, 303);
    assert.equal(db.prepare("SELECT name FROM workspaces WHERE created_via='signup'").get().name, "person's workspace");
    assert.equal(db.prepare("SELECT accepted_by FROM workspace_invitations WHERE id='invite'").get().accepted_by, null);
});

test('workspace name length counts Unicode characters after trimming, including the generated name', async t => {
    const w = await signupWorld(t), { db } = w, unicode = '🌱'.repeat(120);
    const named = await mint(w, { fields: { workspace_name: ' ' + unicode + ' ' } });
    assert.equal((await verify(w, named)).status, 303);
    const local = 'x'.repeat(130), defaultName = 'x'.repeat(108) + "'s workspace";
    assert.equal((await verify(w, await mint(w, { email: local + '@example.com' }))).status, 303);
    assert.deepEqual(db.prepare('SELECT name FROM workspaces ORDER BY name').all().map(row => row.name), [defaultName, unicode]);
});

test('GitHub provider proof cannot enroll an unadmitted address', async t => {
    const w = await signupWorld(t), flow = await begin(w), calls = [];
    t.mock.method(globalThis, 'fetch', async target => {
        const uri = String(target);
        calls.push(uri);
        if (uri === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'provider-token' });
        if (uri === 'https://api.github.com/user') return Response.json({ id: 42, login: 'person' });
        if (uri === 'https://api.github.com/user/emails?per_page=100') return Response.json([{ email: person, primary: true, verified: true }]);
        throw new Error('Unexpected network request');
    });
    const start = await w.call('/v1/auth/github/start?request_id=' + flow.request_id, { headers: { cookie: flow.cookie } });
    assert.equal(start.status, 303, await start.clone().text());
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const response = await w.call('/auth/github/callback?' + new URLSearchParams({ state, code: 'github-code', purpose: 'signup' }),
        { headers: { cookie: flow.cookie + '; ' + cookieJar(start) } });
    await refused(response, 403, 'access_denied');
    assert.equal(calls.length, 3);
    for (const table of ['users', 'workspaces', 'client_admissions', 'sessions']) assert.equal(count(w.db, table), 0);
});

test('sign-up requires valid Turnstile when configured and honors address and email limits', async t => {
    const w = await signupWorld(t, { botCheck: true }), flow = await begin(w);
    turnstile(t, { action: 'wrong' });
    await refused(await ask(w, flow), 400, 'turnstile_required');
    await refused(await ask(w, flow, person, { turnstile: 'wrong-action' }), 400, 'turnstile_invalid');
    turnstile(t);
    const challenge = crypto.randomUUID();
    assert.equal((await ask(w, flow, person, { turnstile: challenge })).status, 202);
    await refused(await ask(w, flow, person, { turnstile: challenge }), 400, 'turnstile_invalid');
    for (let i = 0; i < 5; ++i) {
        const response = await ask(w, flow, person, { turnstile: crypto.randomUUID() }, { 'cf-connecting-ip': `192.0.2.${i + 1}` });
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { accepted: true });
    }
    await w.drain();
    assert.equal(w.mails.length, 5);
    assert.equal(count(w.db, 'magic_links'), 5);
    w.env.AUTH_LIMITER = { async limit() { return { success: false }; } };
    await refused(await ask(w, flow, 'another@example.com', { turnstile: crypto.randomUUID() }), 429, 'rate_limit');
    assert.equal(w.mails.length, 5);
});

test('degraded Turnstile preserves the ordinary existing-account path and blocks all workspace creation', async t => {
    const w = await signupWorld(t, { botCheck: true }), flow = await begin(w);
    const admitted = await ensureUser(w.env, 'admitted@example.com');
    await ensureUser(w.env, 'unadmitted@example.com');
    w.db.prepare("INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,'app',0)").run(admitted.id);
    t.mock.method(globalThis, 'fetch', async uri => {
        assert.match(uri, /^https:\/\/challenges\.cloudflare\.com\//);
        return new Response(null, { status: 503 });
    });
    for (const email of [admitted.email, 'unadmitted@example.com', person, 'new2@example.com', 'new3@example.com']) {
        const response = await ask(w, flow, email, { turnstile: crypto.randomUUID() });
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { accepted: true });
    }
    await refused(await ask(w, flow, 'new4@example.com', { turnstile: crypto.randomUUID() }), 429, 'rate_limit');
    await w.drain();
    assert.equal(w.mails.length, 1);
    assert.equal(w.mails[0].subject, 'Sign in to Notes');
    assert.equal(w.db.prepare('SELECT purpose FROM magic_links').get().purpose, 'sign_in');
    assert.equal(count(w.db, 'workspaces'), 0);
});

test('a public OAuth app uses the same signup guard', async t => {
    const w = await signupWorld(t);
    w.db.exec("UPDATE clients SET secret_hash=NULL WHERE id='app'");
    const response = await verify(w, await mint(w));
    assert.equal(response.status, 303, await response.clone().text());
    assert.equal(count(w.db, 'workspaces'), 1);
});
