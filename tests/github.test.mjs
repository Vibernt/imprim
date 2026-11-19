// GitHub sign-in: state, PKCE, numeric identity and admission boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, begin, cookieJar } from './support/world.mjs';
import { challengeOf, sha256 } from '../apps/server/src/lib/crypto.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { addTeam, configureJoin, joinPath } from './support/workspace-join.mjs';
async function start(w, jar = '') {
    const flow = await begin(w, jar, jar ? { prompt: 'login' } : {}), response = await w.call(`/v1/auth/github/start?request_id=${flow.request_id}`, { headers: { cookie: [flow.cookie, jar].filter(Boolean).join('; ') } });
    return { ...flow, response, url: new URL(response.headers.get('location')), cookie: flow.cookie + '; ' + cookieJar(response) };
}
function github(t, profile = {}) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.redirect, 'manual');
        if (url.endsWith('/access_token')) return Response.json({ access_token: 'provider-token' });
        if (url.endsWith('/user')) return Response.json({ id: 42, login: 'person', ...profile.user });
        if (url.includes('/user/emails')) return Response.json(profile.emails || [{ email: 'person@example.com', primary: true, verified: true }]);
        throw new Error('unexpected network');
    });
    return calls;
}
const callback = (w, flow, changes = {}, cookie = flow.cookie) => w.call('/auth/github/callback?' + new URLSearchParams({ code: 'github-code', state: flow.url.searchParams.get('state'), ...changes }), { headers: { cookie } });
test('an already linked GitHub owner can start a hosted join without app admission', async t => {
    const w = await world(t, 'invited'), db = w.env.DB.db;
    github(t);
    configureJoin(db, 'other', 'app');
    const owner = await ensureUser(w.env, 'person@example.com');
    addTeam(db, 'team', owner.id);
    db.prepare("INSERT INTO user_identities(provider,provider_id,user_id,created) VALUES('github','42',?,0)").run(owner.id);
    const signed = await callback(w, await start(w));
    assert.equal(signed.status, 303, await signed.clone().text());
    assert.equal(new URL(signed.headers.get('location')).pathname, joinPath);
    assert.equal(db.prepare('SELECT count(*) AS n FROM client_admissions').get().n, 0);
});
test('GitHub state is hashed, browser-bound, uses S256 and exchanges verifier before linking numeric id', async t => {
    const w = await world(t), calls = github(t), flow = await start(w);
    const row = w.env.DB.db.prepare('SELECT * FROM oauth_states').get();
    assert.equal(row.hash, await sha256(flow.url.searchParams.get('state')));
    assert.equal(flow.url.searchParams.get('code_challenge'), await challengeOf(row.verifier));
    assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(flow.response.headers.get('set-cookie'), /__Host-vi_oauth=.*Path=\/; Secure; SameSite=Lax; Max-Age=600; HttpOnly/);
    const response = await callback(w, flow); assert.equal(response.status, 303);
    const exchange = JSON.parse(calls[0].options.body);
    assert.equal(exchange.client_secret, 'github-secret');
    assert.equal(exchange.code_verifier, row.verifier);
    assert.equal(exchange.redirect_uri, w.env.ISSUER + '/auth/github/callback');
    const identity = w.env.DB.db.prepare('SELECT * FROM user_identities').get();
    assert.equal(identity.provider_id, '42');
    assert.equal(w.env.DB.db.prepare('SELECT method FROM sessions').get().method, 'github');
    assert.equal((await callback(w, flow)).status, 401);
    assert.equal(calls.length, 3);
});
for (const kind of ['missing state', 'malformed state', 'unknown state', 'expired', 'wrong cookie', 'missing cookie', 'wrong authorization browser', 'cancelled', 'bad code'])
    test(`GitHub refuses ${kind} before network`, async t => {
        const w = await world(t), calls = github(t), flow = await start(w);
        if (kind === 'expired') w.env.DB.db.exec('UPDATE oauth_states SET expires_at=0');
        const changes = kind === 'missing state' ? { state: '' } : kind === 'malformed state' ? { state: 'bad' }
            : kind === 'unknown state' ? { state: 'z'.repeat(43) } : kind === 'cancelled' ? { error: 'access_denied' }
            : kind === 'bad code' ? { code: 'bad code' } : {};
        const jar = kind === 'missing cookie' ? flow.cookie.replace(/; __Host-vi_oauth=[^;]+/, '')
            : kind === 'wrong cookie' ? flow.cookie.replace(/__Host-vi_oauth=[^;]+/, '__Host-vi_oauth=' + 'x'.repeat(43))
            : kind === 'wrong authorization browser' ? flow.cookie.replace(/__Host-vi_browser=[^;]+/, '__Host-vi_browser=' + 'x'.repeat(43)) : flow.cookie;
        const response = await callback(w, flow, changes, jar);
        assert.ok([401,403].includes(response.status));
        assert.equal(calls.length, 0);
        assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
        assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    });
for (const kind of ['unverified primary', 'verified nonprimary', 'invalid numeric id']) test(`GitHub refuses ${kind}`, async t => {
    const w = await world(t);
    github(t, kind === 'invalid numeric id' ? { user: { id: '42' } } : { emails: [{ email: 'person@example.com', primary: kind === 'unverified primary', verified: kind !== 'unverified primary' }] });
    const response = await callback(w, await start(w)); assert.ok([403,502].includes(response.status));
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});
test('GitHub never auto-links an existing account by email: its verified flag is not mailbox proof (S4)', async t => {
    const w = await world(t); github(t);
    w.env.DB.db.exec("INSERT INTO users(id,email,email_verified,created) VALUES('original','person@example.com',1,0)");
    const response = await callback(w, await start(w));
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Sign in with an email link first/);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM user_identities').get().n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
});
test('GitHub links an existing account from a browser already signed in to it; stable numeric identity survives email/login changes', async t => {
    const w = await world(t);
    const user = await ensureUser(w.env, 'person@example.com'), signed = await issueSession(w.env, user, 'email');
    const jar = signed.cookies.map(c => c.split(';')[0]).join('; ');
    github(t);
    const flow = await start(w, jar);
    assert.equal((await callback(w, flow, {}, [flow.cookie, jar].join('; '))).status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id, user.id);
    github(t, { user: { login: 'renamed' }, emails: [{ email: 'changed@example.com', primary: true, verified: true }] });
    assert.equal((await callback(w, await start(w))).status, 303);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    assert.equal(w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id, user.id);
});
test('GitHub verified email does not satisfy an allowed domain (S4)', async t => {
    const w = await world(t, 'invited'); github(t);
    w.env.DB.db.exec(`UPDATE clients SET allowed_domains='["example.com"]'`);
    assert.equal((await callback(w, await start(w))).status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});
for (const kind of ['admin email', 'linked admin', 'blocked', 'deleted', 'invited unknown']) test(`GitHub refuses ${kind}`, async t => {
    const w = await world(t, kind === 'invited unknown' ? 'invited' : 'open');
    github(t, kind === 'admin email' ? { emails: [{ email: 'admin@example.com', primary: true, verified: true }] } : {});
    if (['blocked', 'deleted', 'linked admin'].includes(kind)) {
        w.env.DB.db.prepare('INSERT INTO users(id,email,status,created) VALUES(?,?,?,0)').run('old', kind === 'linked admin' ? 'admin@example.com' : 'person@example.com', kind === 'linked admin' ? 'active' : kind);
        w.env.DB.db.exec("INSERT INTO user_identities(provider,provider_id,user_id,created) VALUES('github','42','old',0)");
    }
    assert.equal((await callback(w, await start(w))).status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
});
test('GitHub exchange failure consumes state and never creates an account', async t => {
    const w = await world(t);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'bad_verification_code' }));
    const flow = await start(w);
    assert.equal((await callback(w, flow)).status, 502);
    assert.equal((await callback(w, flow)).status, 401);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});
test('GitHub ID token names github amr', async t => {
    const w = await world(t); github(t);
    const response = await callback(w, await start(w));
    const code = new URL(response.headers.get('location')).searchParams.get('code');
    const tokens = await (await w.exchange(code)).json();
    assert.deepEqual(JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url')).amr, ['github']);
});
test('GitHub rejects a provider id linked to a different existing email owner', async t => {
    const w = await world(t); github(t);
    w.env.DB.db.exec(`INSERT INTO users(id,email,created) VALUES('a','person@example.com',0),('b','other@example.com',0);
    INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES('github','42','b','person',0)`);
    assert.equal((await callback(w, await start(w))).status, 403);
    assert.equal(w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id, 'b');
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});

test('GitHub sign-in after merging provider-created source authenticates as survivor', async t => {
    const { changeUser } = await import('../apps/server/src/admin/users.mjs');
    const w = await world(t); github(t);
    assert.equal((await callback(w, await start(w))).status, 303);
    const source = w.env.DB.db.prepare('SELECT * FROM users').get();
    w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('survivor','survivor@example.com',0)");
    await changeUser(w.env, 'operator', source.id, 'merge', 'survivor', source.email);
    const response = await callback(w, await start(w)); assert.equal(response.status, 303);
    const tokens = await (await w.exchange(new URL(response.headers.get('location')).searchParams.get('code'))).json();
    assert.equal(JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url')).sub, 'survivor');
});
