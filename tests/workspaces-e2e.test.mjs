import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../apps/server/src/worker.mjs';
import { challengeOf, sha256 } from '../apps/server/src/lib/crypto.mjs';
import { createClient } from '../packages/imprim-client/index.mjs';
import { error, redirectUri as agentRedirect } from './support/agents.mjs';
import { basic, cookieJar, world } from './support/world.mjs';

const ownerEmail = 'owner@example.com';
const memberEmail = 'member@example.com';
const teamName = 'Cross-product team';
const sharedApps = ['alpha', 'beta', 'beta-console'];
const appOrigin = id => `https://${id}.example`;
const resourceAt = (app, id) => `${appOrigin(app)}/w/${id}/mcp`;
const actor = login => ({ actorToken: login.idToken });

async function fixture(t) {
    const w = await world(t, 'invited');
    const db = w.env.DB.db;
    const queued = [], posts = [];
    const secretHash = await sha256('secret');
    const apps = {};
    const backchannels = new Map();
    db.prepare("UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id=?").run('default');
    const addApp = db.prepare(`INSERT INTO clients
        (id,secret_hash,redirect_uris,post_logout_uris,signup_policy,sign_in_methods,product,workspaces,
         personal_workspaces,workspace_admin,initiate_login_uri,backchannel_uri,agent_access,agent_registration_methods,
         agent_scope_catalogue,agent_resource_prefixes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [id, product, mode, personal, admin] of [
        ['alpha', 'alpha', 'shared', 'on', 'on'],
        ['beta', 'beta', 'shared', 'off', 'off'],
        ['beta-console', 'beta', 'shared', 'off', 'on'],
        ['app-local', 'alpha', 'app', 'off', 'off']
    ]) {
        const origin = appOrigin(id), redirectUri = origin + '/callback', backchannel = origin + '/backchannel';
        addApp.run(id, secretHash, JSON.stringify([redirectUri]), '[]', 'invited', '["email"]', product, mode,
            personal, admin, origin + '/start', backchannel, 'on', '["dynamic"]',
            '{"read":"Read workspace"}', JSON.stringify([origin + '/w/']));
        backchannels.set(backchannel, id);
        const idTokens = new Map();
        apps[id] = createClient({ issuer: w.env.ISSUER, clientId: id, clientSecret: 'secret', redirectUri,
            fetch: async (url, init) => {
                const target = new URL(url);
                assert.equal(target.origin, w.env.ISSUER);
                const response = await w.call(target.pathname + target.search, init);
                if (target.pathname === '/token' && response.ok && init.body.get('grant_type') === 'authorization_code') {
                    const { id_token } = await response.clone().json();
                    idTokens.set(init.body.get('code'), id_token);
                }
                return response;
            } });
        // handleCallback returns claims. The API needs the original token from that callback's exchange.
        apps[id].takeIdToken = callback => {
            const code = new URL(callback).searchParams.get('code');
            const token = idTokens.get(code);
            idTokens.delete(code);
            return token;
        };
    }
    w.env.LOGOUT_QUEUE = { async send(message) { queued.push(message); } };
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = String(input);
        if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
            return Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' });
        assert.ok(backchannels.has(url), 'Unexpected outbound destination');
        posts.push({ app: backchannels.get(url), method: init.method, type: init.headers['content-type'], form: init.body });
        return new Response(null, { status: 204 });
    });

    // Run the real scheduled dispatcher and queue consumer, then verify what each app received over HTTP.
    async function deliveries() {
        await w.drain();
        await worker.scheduled({}, w.env);
        const outcomes = [];
        const messages = queued.splice(0).map(body => ({
            body, ack() { outcomes.push('ack'); }, retry() { outcomes.push('retry'); }
        }));
        await worker.queue({ messages }, w.env);
        assert.deepEqual(outcomes, messages.map(() => 'ack'));
        return Promise.all(posts.splice(0).map(async ({ app, method, type, form }) => {
            assert.equal(method, 'POST');
            assert.equal(type, 'application/x-www-form-urlencoded');
            assert.equal([...form.keys()].length, 1);
            const verified = await apps[app].verifyBackchannel(form);
            return { app, ...verified, form };
        }));
    }

    const admissions = sub => db.prepare('SELECT client_id,source FROM client_admissions WHERE user_id=? ORDER BY client_id')
        .all(sub).map(({ client_id, source }) => [client_id, source]);
    const form = (path, fields, cookie = '', headers = {}) => w.call(path, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie, ...headers },
        body: new URLSearchParams(fields)
    });
    return { ...w, apps, deliveries, admissions, form, db };
}

function withCookies(previous, response) {
    const jar = new Map();
    for (const cookie of [previous, cookieJar(response)].filter(Boolean).flatMap(value => value.split('; '))) {
        jar.set(cookie.slice(0, cookie.indexOf('=')), cookie);
    }
    return [...jar.values()].join('; ');
}

async function startLogin(w, app, cookie = '', options = {}) {
    const flow = await app.startLogin(options);
    const url = new URL(flow.url);
    const response = await w.call(url.pathname + url.search, { headers: { cookie } });
    return { flow, response, cookie: withCookies(cookie, response) };
}

async function finishLogin(app, flow, response, cookie) {
    assert.equal(response.status, 303);
    const callback = response.headers.get('location');
    const claims = await app.handleCallback(callback, flow);
    const idToken = app.takeIdToken(callback);
    assert.ok(idToken, 'OIDC callback exchanged an ID token');
    return { claims, idToken, cookie: withCookies(cookie, response) };
}

async function requestLink(w, app, email) {
    const flow = await startLogin(w, app);
    assert.equal(flow.response.status, 200);
    const requestId = (await flow.response.text()).match(/data-request-id="([^"]+)"/)?.[1];
    assert.ok(requestId, 'sign-in request bound to the browser');
    const before = w.mails.length;
    const response = await w.post('/v1/auth/magic/request', { request_id: requestId, email, turnstile: crypto.randomUUID() }, flow.cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true });
    await w.drain();
    return { ...flow, mails: w.mails.slice(before) };
}

async function mailLogin(w, app, email, { checkBrowser = false } = {}) {
    const { flow, cookie, mails } = await requestLink(w, app, email);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, email);
    const token = mails[0].text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token, 'email contains a sign-in link');
    if (checkBrowser) {
        const foreign = await startLogin(w, app);
        await error(await w.post('/v1/auth/magic/verify', { token }, foreign.cookie), 'invalid_grant', 401);
        await error(await w.post('/v1/auth/magic/verify', { token }, cookie, { origin: 'https://foreign.example' }), 'origin', 403);
    }
    const response = await w.post('/v1/auth/magic/verify', { token }, cookie);
    const login = await finishLogin(app, flow, response, cookie);
    if (checkBrowser) await error(await w.post('/v1/auth/magic/verify', { token }, cookie), 'invalid_grant', 401);
    return login;
}

async function sso(w, app, login) {
    const { flow, response, cookie } = await startLogin(w, app, login.cookie, { prompt: 'none' });
    const result = await finishLogin(app, flow, response, cookie);
    assert.equal(result.claims.sub, login.claims.sub);
    return result;
}

async function refuseSignIn(w, app, email, login) {
    const { flow, response } = await startLogin(w, app, login.cookie, { prompt: 'none' });
    assert.equal(response.status, 303);
    await assert.rejects(app.handleCallback(response.headers.get('location'), flow), { code: 'access_denied' });
    assert.equal((await requestLink(w, app, email)).mails.length, 0);
}

async function appGuest(w, app, email) {
    await app.inviteEmail(email);
    return mailLogin(w, app, email);
}

async function team(w) {
    const { alpha, 'beta-console': console } = w.apps;
    const owner = await appGuest(w, console, ownerEmail);
    const ownerAlpha = await appGuest(w, alpha, ownerEmail);
    const workspace = await console.createWorkspace({
        name: teamName, firstOwnerEmail: ownerEmail, ...actor(owner)
    });
    await alpha.setWorkspaceProducts(workspace.workspace_id, { add: ['alpha'], remove: [], ...actor(ownerAlpha) });
    return { owner, workspace, id: workspace.workspace_id };
}

async function inviteMember(w, id, ownerAlpha, email = memberEmail, role = 'member') {
    return w.apps.alpha.inviteToWorkspace(id, { email, role, ...actor(ownerAlpha) });
}

async function joinedTeam(w) {
    const group = await team(w);
    const ownerAlpha = await sso(w, w.apps.alpha, group.owner);
    await inviteMember(w, group.id, ownerAlpha);
    const member = await mailLogin(w, w.apps.beta, memberEmail);
    const memberAlpha = await sso(w, w.apps.alpha, member);
    return { ...group, ownerAlpha, member, memberAlpha, sub: member.claims.sub };
}

async function workspaceAdmin(w, group) {
    const email = 'workspace-admin@example.com';
    await inviteMember(w, group.id, group.ownerAlpha, email, 'admin');
    return mailLogin(w, w.apps.beta, email);
}

function eventsOf(deliveries, kind, event) {
    return deliveries.filter(row => row.kind === kind && (event === undefined || row.claims.event === event));
}

function recipients(events) {
    return events.map(row => row.app).sort();
}

async function startAgent(w, login, resource, clientId) {
    const query = new URLSearchParams({
        client_id: clientId, resource, redirect_uri: agentRedirect, scope: 'read', state: 'agent-state',
        response_type: 'code', code_challenge: await challengeOf(w.verifier), code_challenge_method: 'S256'
    });
    const response = await w.call('/authorize?' + query, { headers: { cookie: login.cookie } });
    assert.equal(response.status, 303);
    const consent = new URL(response.headers.get('location'));
    assert.equal(consent.origin + consent.pathname, w.env.ISSUER + '/agent/consent');
    const cookie = withCookies(login.cookie, response), csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)?.[1];
    assert.ok(csrf);
    return {
        page: () => w.call(consent.pathname + consent.search, { headers: { cookie } }),
        approve: (headers = {}, suppliedCsrf = csrf) => w.form('/agent/consent', {
            request_id: consent.searchParams.get('request_id'), csrf: suppliedCsrf, decision: 'approve'
        }, cookie, headers)
    };
}

async function registerAgent(w) {
    const response = await w.post('/register', { client_name: 'Workspace Assistant', redirect_uris: ['http://127.0.0.1/callback'] });
    assert.equal(response.status, 201);
    return (await response.json()).client_id;
}

async function connectAgent(w, login, clientId, resource, app, name, checkApproval = false) {
    const flow = await startAgent(w, login, resource, clientId);
    const consent = await flow.page();
    assert.equal(consent.status, 200);
    assert.ok((await consent.text()).includes(name), 'consent displays the registered workspace name');
    if (checkApproval) {
        await error(await flow.approve({ origin: 'https://foreign.example' }), 'origin', 403);
        await error(await flow.approve({}, 'wrong-csrf'), 'csrf', 403);
    }
    const approved = await flow.approve();
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get('location'));
    assert.equal(callback.origin + callback.pathname, agentRedirect);
    assert.equal(callback.searchParams.get('state'), 'agent-state');
    const code = callback.searchParams.get('code');
    assert.ok(code);
    const response = await w.form('/token', { grant_type: 'authorization_code', client_id: clientId, resource,
        code, redirect_uri: agentRedirect, code_verifier: w.verifier });
    assert.equal(response.status, 200);
    const tokens = await response.json();
    const claims = await app.verifyAccessToken(tokens.access_token, { audience: resource });
    assert.equal(claims.sub, login.claims.sub);
    return { tokens, claims, refresh: (target = resource) => w.form('/token', {
        grant_type: 'refresh_token', client_id: clientId, resource: target, refresh_token: tokens.refresh_token
    }) };
}

const rejectWorkspace = (request, code, status) => assert.rejects(request, {
    code, message: `Identity workspaces request failed (HTTP ${status}).`
});

test('a workspace invitation from alpha admits a beta member and delivers versioned events to all shared apps', async t => {
    const w = await fixture(t);
    const { alpha, beta, 'beta-console': console } = w.apps;
    const betaAdmin = await appGuest(w, beta, 'admin@example.com');
    const fields = { name: teamName, products: ['beta'], firstOwnerEmail: ownerEmail };
    await rejectWorkspace(beta.createWorkspace({ ...fields, ...actor(betaAdmin) }), 'access_denied', 403);
    assert.deepEqual(await beta.memberships(betaAdmin.claims.sub), { memberships: [] });
    assert.equal((await w.deliveries()).length, 0);

    const group = await team(w);
    assert.match(group.id, /^ws_[0-9a-f]{32}$/);
    const ownerAlpha = await sso(w, alpha, group.owner);
    const initialEvents = await w.deliveries();
    const created = eventsOf(initialEvents, 'workspace', 'workspace-member-added');
    const productsChanged = eventsOf(initialEvents, 'workspace', 'workspace-products-changed');
    assert.deepEqual(recipients(created), ['beta', 'beta-console']);
    assert.deepEqual(recipients(productsChanged), sharedApps);
    for (const { claims } of productsChanged) {
        assert.deepEqual(claims.payload, { workspace_id: group.id, version: group.workspace.version + 1, products: ['alpha', 'beta'] });
    }
    await rejectWorkspace(alpha.inviteToWorkspace(group.id, { email: memberEmail, role: 'member', ...actor(group.owner) }),
        'invalid_request', 400);
    await error(await w.call('/v1/memberships?' + new URLSearchParams({ sub: ownerAlpha.claims.sub }), {
        headers: { authorization: basic('alpha', 'wrong-secret') }
    }), 'invalid_client', 401);

    const before = w.mails.length;
    const invitation = await inviteMember(w, group.id, ownerAlpha);
    await w.drain();
    const invitations = w.mails.slice(before);
    assert.equal(invitations.length, 1);
    const [mail] = invitations;
    assert.equal(mail.to, memberEmail);
    assert.equal(mail.subject, 'Invitation to ' + teamName);
    assert.ok(mail.html.includes('class="im-button-text" href="https://alpha.example/start"'));
    for (const value of [ownerEmail, teamName, 'alpha', 'beta', 'https://alpha.example/start']) assert.ok(mail.text.includes(value));
    assert.deepEqual(await beta.workspaceInvitations(group.id), { invitations: [{
        ...invitation, email: memberEmail, role: 'member'
    }] });

    const member = await mailLogin(w, beta, memberEmail, { checkBrowser: true });
    const sub = member.claims.sub;
    assert.deepEqual(w.admissions(sub), [['beta', 'workspace']]);
    assert.deepEqual(await alpha.workspaceInvitations(group.id), { invitations: [] });
    const accepted = w.db.prepare('SELECT accepted_at,accepted_by FROM workspace_invitations WHERE id=?').get(invitation.invitation_id);
    assert.ok(accepted.accepted_at > 0);
    assert.equal(accepted.accepted_by, sub);
    const { version, members } = await beta.workspaceMembers(group.id);
    assert.ok(members.some(row => row.sub === sub && row.email === memberEmail && row.role === 'member'));
    const expected = { workspace_id: group.id, name: teamName, kind: 'team', created_via: null, role: 'member', products: ['alpha', 'beta'], version };
    for (const app of [alpha, beta, console]) assert.deepEqual(await app.memberships(sub), { memberships: [expected] });

    const joined = eventsOf(await w.deliveries(), 'workspace', 'workspace-member-added');
    assert.deepEqual(recipients(joined), sharedApps);
    const workspaceEvents = [...created, ...productsChanged, ...joined];
    assert.equal(new Set(workspaceEvents.map(event => event.claims.jti)).size, workspaceEvents.length);
    for (const { claims: first } of created) {
        assert.equal(first.sub, ownerAlpha.claims.sub);
        assert.deepEqual(first.payload, { workspace_id: group.id, version: group.workspace.version, role: 'owner' });
    }
    for (const { app, claims } of joined) {
        assert.equal(claims.sub, sub);
        assert.ok(claims.version > productsChanged.find(row => row.app === app).claims.version);
        assert.equal(claims.version, version);
        assert.deepEqual(claims.payload, { workspace_id: group.id, version, role: 'member' });
    }
    await assert.rejects(alpha.verifyBackchannel(joined.find(row => row.app === 'beta').form), { code: 'invalid_token' });
});

test('removing a member revokes their registered beta grant, logs both apps out and prevents sign-in', async t => {
    const w = await fixture(t), group = await joinedTeam(w);
    const { alpha, beta } = w.apps;
    const admin = await workspaceAdmin(w, group);
    const resource = resourceAt('beta', group.id);
    await rejectWorkspace(alpha.registerWorkspaceResource(group.id, resource), 'invalid_target', 403);
    await beta.registerWorkspaceResource(group.id, resource);
    const agent = await registerAgent(w);
    const outsider = await appGuest(w, beta, 'outsider@example.com');
    const denied = await startAgent(w, outsider, resource, agent);
    await error(await denied.page(), 'access_denied', 403);
    await error(await denied.approve(), 'access_denied', 403);
    const grant = await connectAgent(w, group.member, agent, resource, beta, teamName, true);
    assert.equal((await beta.introspect(grant.tokens.access_token)).active, true);
    assert.deepEqual(w.admissions(group.sub), [['alpha', 'workspace'], ['beta', 'workspace']]);
    await rejectWorkspace(beta.removeMember(group.id, admin.claims.sub, actor(group.member)), 'access_denied', 403);
    await w.deliveries();

    const removed = await beta.removeMember(group.id, group.sub, actor(admin));
    assert.deepEqual(w.admissions(group.sub), []);
    assert.deepEqual(await alpha.memberships(group.sub), { memberships: [] });
    assert.deepEqual(await beta.memberships(group.sub), { memberships: [] });
    const events = await w.deliveries();
    const revocations = eventsOf(events, 'revocation');
    assert.deepEqual(recipients(revocations), ['beta']);
    assert.deepEqual(
        [revocations[0].claims.sub, revocations[0].claims.grantId, revocations[0].claims.resource],
        [group.sub, grant.claims.grant_id, resource]
    );
    const logouts = eventsOf(events, 'logout');
    assert.deepEqual(recipients(logouts), ['alpha', 'beta']);
    for (const { app, claims } of logouts) {
        assert.equal(claims.sub, group.sub);
        assert.equal(claims.sid, (app === 'alpha' ? group.memberAlpha : group.member).claims.sid);
    }
    const membershipEvents = eventsOf(events, 'workspace', 'workspace-member-removed');
    assert.deepEqual(recipients(membershipEvents), sharedApps);
    for (const { claims } of membershipEvents) {
        assert.equal(claims.sub, group.sub);
        assert.deepEqual(claims.payload, { workspace_id: group.id, version: removed.version });
    }
    assert.deepEqual(await beta.introspect(grant.tokens.access_token), { active: false });
    await error(await grant.refresh(), 'invalid_grant', 400);
    await refuseSignIn(w, alpha, memberEmail, group.member);
});

test('leaving the first workspace preserves alpha admission and the grant for a second alpha workspace', async t => {
    const w = await fixture(t), group = await joinedTeam(w);
    const { alpha, beta, 'beta-console': console } = w.apps;
    const admin = await workspaceAdmin(w, group);
    const second = await console.createWorkspace({ name: 'Alpha team', firstOwnerEmail: ownerEmail, ...actor(group.owner) });
    const id = second.workspace_id;
    await alpha.setWorkspaceProducts(id, { add: ['alpha'], remove: [], ...actor(group.ownerAlpha) });
    await console.setWorkspaceProducts(id, { add: [], remove: ['beta'], ...actor(group.owner) });
    await rejectWorkspace(beta.workspace(id), 'not_found', 404);
    const invitation = await inviteMember(w, id, group.ownerAlpha);
    await sso(w, beta, group.member);
    assert.deepEqual((await alpha.workspaceInvitations(id)).invitations, [{
        ...invitation, email: memberEmail, role: 'member'
    }]);
    // An existing alpha admission still lets a proven mailbox accept a new workspace invitation.
    const member = await mailLogin(w, alpha, memberEmail, { checkBrowser: true });
    assert.deepEqual(await alpha.workspaceInvitations(id), { invitations: [] });
    assert.deepEqual((await alpha.memberships(group.sub)).memberships.map(row => row.workspace_id).sort(), [group.id, id].sort());

    const firstResource = resourceAt('beta', group.id), secondResource = resourceAt('alpha', id);
    await beta.registerWorkspaceResource(group.id, firstResource);
    await alpha.registerWorkspaceResource(id, secondResource);
    const agent = await registerAgent(w);
    const first = await connectAgent(w, member, agent, firstResource, beta, teamName);
    const retained = await connectAgent(w, member, agent, secondResource, alpha, 'Alpha team');
    await error(await retained.refresh(firstResource), 'invalid_grant', 400);
    await w.deliveries();

    await beta.removeMember(group.id, group.sub, actor(admin));
    assert.deepEqual(w.admissions(group.sub), [['alpha', 'workspace']]);
    assert.deepEqual((await alpha.memberships(group.sub)).memberships.map(row => row.workspace_id), [id]);
    assert.deepEqual(await beta.memberships(group.sub), { memberships: [] });
    const events = await w.deliveries();
    assert.deepEqual(recipients(eventsOf(events, 'logout')), ['beta']);
    const revocations = eventsOf(events, 'revocation');
    assert.deepEqual(recipients(revocations), ['beta']);
    assert.equal(revocations[0].claims.grantId, first.claims.grant_id);
    assert.equal(revocations[0].claims.resource, firstResource);
    await error(await first.refresh(), 'invalid_grant', 400);
    assert.equal((await alpha.introspect(retained.tokens.access_token)).active, true);
    const refresh = await retained.refresh();
    assert.equal(refresh.status, 200);
    const refreshed = await alpha.verifyAccessToken((await refresh.json()).access_token, { audience: secondResource });
    assert.equal(refreshed.grant_id, retained.claims.grant_id);
    await sso(w, alpha, member);
    await refuseSignIn(w, beta, memberEmail, member);
});

test('personal workspace creation is unique, gated by the app and does not allow invitations', async t => {
    const w = await fixture(t), { alpha, beta } = w.apps;
    const owner = await appGuest(w, alpha, ownerEmail);
    const ownerBeta = await appGuest(w, beta, ownerEmail);
    const fields = { kind: 'personal', name: 'My workspace' };
    await rejectWorkspace(beta.createWorkspace({ ...fields, ...actor(ownerBeta) }), 'access_denied', 403);
    const personal = await alpha.createWorkspace({ ...fields, ...actor(owner) });
    const id = personal.workspace_id;
    const before = w.mails.length;
    await rejectWorkspace(alpha.createWorkspace({ ...fields, ...actor(owner) }), 'personal_workspace_exists', 409);
    await rejectWorkspace(inviteMember(w, id, owner), 'personal_workspace', 409);
    assert.equal(w.mails.length, before);
    assert.deepEqual(await alpha.workspaceInvitations(id), { invitations: [] });
    assert.deepEqual(await alpha.workspaceMembers(id), {
        members: [{ sub: owner.claims.sub, email: ownerEmail, role: 'owner' }], next_cursor: null, version: personal.version
    });
    assert.deepEqual(await alpha.memberships(owner.claims.sub), { memberships: [{
        workspace_id: id, kind: 'personal', created_via: null, name: fields.name, role: 'owner', products: ['alpha'], version: personal.version
    }] });
    assert.deepEqual(await beta.memberships(owner.claims.sub), { memberships: [] });
});

test('beta can block workspace closure with a hold, and releasing it lets the owner terminate access', async t => {
    const w = await fixture(t), group = await joinedTeam(w);
    const { alpha, beta } = w.apps;
    const hold = await beta.holdWorkspace(group.id, 'Unpaid balance');
    await w.deliveries();
    await rejectWorkspace(alpha.releaseWorkspace(group.id), 'not_found', 404);
    await rejectWorkspace(beta.closeWorkspace(group.id, actor(group.member)), 'access_denied', 403);
    await assert.rejects(alpha.closeWorkspace(group.id, actor(group.ownerAlpha)), {
        code: 'workspace_held', message: 'Identity workspaces request failed (HTTP 409).', description: /Unpaid balance/
    });
    assert.deepEqual(await alpha.workspace(group.id), hold);
    assert.deepEqual(w.admissions(group.sub), [['alpha', 'workspace'], ['beta', 'workspace']]);
    assert.equal((await w.deliveries()).length, 0);

    const released = await beta.releaseWorkspace(group.id);
    const closed = await alpha.closeWorkspace(group.id, actor(group.ownerAlpha));
    assert.equal(closed.status, 'closed');
    assert.equal(closed.version, released.version + 1);
    assert.deepEqual(await beta.workspace(group.id), closed);
    const events = await w.deliveries();
    const closes = eventsOf(events, 'workspace', 'workspace-closed');
    assert.deepEqual(recipients(closes), sharedApps);
    for (const { claims } of closes) {
        assert.equal(claims.sub, undefined);
        assert.deepEqual(claims.payload, { workspace_id: group.id, version: closed.version });
    }
    assert.deepEqual(recipients(eventsOf(events, 'logout').filter(row => row.claims.sub === group.sub)), ['alpha', 'beta']);
    for (const app of [alpha, beta]) {
        assert.deepEqual(await app.memberships(group.sub), { memberships: [] });
        await refuseSignIn(w, app, memberEmail, group.member);
    }
    assert.deepEqual(w.admissions(group.sub), []);
    assert.deepEqual(w.admissions(group.owner.claims.sub), [['alpha', 'app'], ['beta-console', 'app']]);
});

test('an app-only guest starts with no membership and keeps the app admission after leaving a workspace', async t => {
    const w = await fixture(t);
    const { alpha, beta } = w.apps;
    const guest = await appGuest(w, alpha, memberEmail);
    const sub = guest.claims.sub;
    assert.deepEqual(w.admissions(sub), [['alpha', 'app']]);
    assert.deepEqual(await alpha.memberships(sub), { memberships: [] });
    await refuseSignIn(w, beta, memberEmail, guest);

    const group = await team(w);
    const ownerAlpha = await sso(w, alpha, group.owner);
    await inviteMember(w, group.id, ownerAlpha);
    const joined = await mailLogin(w, beta, memberEmail);
    assert.equal(joined.claims.sub, sub);
    assert.deepEqual(w.admissions(sub), [['alpha', 'app'], ['beta', 'workspace']]);
    assert.deepEqual((await alpha.memberships(sub)).memberships.map(row => row.workspace_id), [group.id]);
    await beta.removeMember(group.id, sub, actor(joined));

    assert.deepEqual(await alpha.memberships(sub), { memberships: [] });
    assert.deepEqual(await beta.memberships(sub), { memberships: [] });
    assert.deepEqual(w.admissions(sub), [['alpha', 'app']]);
    await sso(w, alpha, joined);
    assert.equal((await mailLogin(w, alpha, memberEmail)).claims.sub, sub);
    await refuseSignIn(w, beta, memberEmail, joined);
});

test('an app-mode client receives 404 for every workspace API route and keeps its app sign-in policy', async t => {
    const w = await fixture(t), { alpha, 'app-local': local } = w.apps;
    const group = await joinedTeam(w);
    await refuseSignIn(w, local, memberEmail, group.member);
    const login = await appGuest(w, local, memberEmail);
    const sub = login.claims.sub, id = group.id, proof = actor(login), resource = resourceAt('app-local', id);
    assert.equal(sub, group.sub);
    const { invitation_id: invitation } = await inviteMember(w, id, group.ownerAlpha, 'pending@example.com');
    const operations = [
        () => local.memberships(sub),
        () => local.workspace(id),
        () => local.workspaceMembers(id),
        () => local.createWorkspace({ name: teamName, products: ['alpha'], firstOwnerEmail: memberEmail, ...proof }),
        () => local.createWorkspace({ kind: 'personal', name: 'Private', ...proof }),
        () => local.renameWorkspace(id, { name: 'Renamed', ...proof }),
        () => local.setWorkspaceProducts(id, { add: [], remove: ['alpha'], ...proof }),
        () => local.inviteToWorkspace(id, { email: 'other@example.com', role: 'member', ...proof }),
        () => local.workspaceInvitations(id),
        () => local.revokeWorkspaceInvitation(id, invitation, proof),
        () => local.setMemberRole(id, sub, { role: 'viewer', ...proof }),
        () => local.removeMember(id, sub, proof),
        () => local.closeWorkspace(id, proof),
        () => local.holdWorkspace(id, 'App-only hold'),
        () => local.releaseWorkspace(id),
        () => local.registerWorkspaceResource(id, resource),
        () => local.unregisterWorkspaceResource(id, resource)
    ];
    const before = await alpha.workspace(id);
    for (const operation of operations) await rejectWorkspace(operation(), 'not_found', 404);
    assert.deepEqual(await alpha.workspace(id), before);
    assert.deepEqual(w.admissions(sub), [['alpha', 'workspace'], ['app-local', 'app'], ['beta', 'workspace']]);
    await sso(w, local, group.member);
    assert.ok((await w.deliveries()).every(row => row.app !== 'app-local'));
});
