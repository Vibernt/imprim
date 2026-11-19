import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';
import { getClient } from '../apps/server/src/oidc/clients.mjs';
import { admitSession } from '../apps/server/src/services/admission.mjs';
import { change, csrf } from './support/account-api.mjs';
import { error } from './support/agents.mjs';
import { basic, login, world } from './support/world.mjs';
import { response, root, setup } from './support/workspaces.mjs';

const endpoint = '/v1/users';
const userPath = sub => endpoint + '?' + new URLSearchParams({ sub });
const readUser = (w, sub) => w.call(userPath(sub), {
    headers: { authorization: basic(), accept: 'text/html', 'accept-language': 'es' }
});
const notFound = async result => assert.deepEqual(await response(result, 404), {
    error: 'not_found', error_description: 'Person not found.'
});

test('an admitted user profile contains only current values and uses the UserInfo name', async t => {
    const w = await world(t);
    const { flow, cookie } = await login(w, t);
    const jar = [flow.cookie, cookie].join('; ');
    const authorized = await w.authorize({ scope: 'openid email profile' }, jar);
    const code = new URL(authorized.headers.get('location')).searchParams.get('code');
    const { access_token } = await response(await w.exchange(code));
    const userinfo = async () => response(await w.call('/userinfo', { headers: { authorization: `Bearer ${access_token}` } }));
    const { sub } = await userinfo();
    const auditCount = () => w.env.DB.db.prepare('SELECT count(*) AS n FROM audit').get().n;
    const before = auditCount();
    const initial = await readUser(w, sub);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response(initial), { sub, email: 'person@example.com', email_verified: true, name: null });
    assert.equal(auditCount(), before);

    await response(await change(w, 'profile', { display_name: '  Ada Lovelace  ' }, jar));
    const profile = await response(await readUser(w, sub));
    assert.deepEqual(profile, { sub, email: 'person@example.com', email_verified: true, name: 'Ada Lovelace' });
    assert.equal(profile.name, (await userinfo()).name);

    const new_email = 'new@example.com';
    await response(await change(w, 'email', { new_email }, jar));
    await w.drain();
    const token = w.mails.find(mail => mail.to === new_email).text.match(/\/account\/email\/confirm\?token=([A-Za-z0-9_-]+)/)[1];
    const confirmed = await w.call('/account/email/confirm', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie: jar },
        body: new URLSearchParams({ csrf: csrf(jar), token })
    });
    assert.equal(confirmed.status, 303);
    await w.drain();
    const afterChange = auditCount();
    assert.deepEqual(await response(await readUser(w, sub)), { sub, email: new_email, email_verified: true, name: 'Ada Lovelace' });
    assert.equal(auditCount(), afterChange);
});

test('workspace admission permits profile reads only while a workspace reaches the shared app product', async t => {
    const w = await setup(t);
    w.db.exec("UPDATE clients SET signup_policy='invited' WHERE id='app'; UPDATE clients SET workspace_admin='on' WHERE id='other'");
    const owner = await w.actor('owner@example.com');
    const member = await w.actor('member@example.com');
    const first = await w.team(owner), last = await w.team(owner, { name: 'Second team' });
    const otherOwner = await w.actor(owner.email, 'other');
    const unrelated = await w.team(otherOwner, { name: 'Tasks team', products: ['tasks'] }, basic('other'));
    for (const workspace of [first, last, unrelated]) w.addMember(workspace.workspace_id, member, 'member');
    await notFound(await readUser(w, member.id));
    await admitSession(w.env, await getClient(w.env, 'app'), member.session);
    const admission = w.db.prepare("SELECT source FROM client_admissions WHERE user_id=? AND client_id='app'");
    assert.equal(admission.get(member.id).source, 'workspace');
    const expected = { sub: member.id, email: member.email, email_verified: true, name: null };
    assert.deepEqual(await response(await readUser(w, member.id)), expected);

    const actor = { actor_token: owner.actor_token };
    await response(await w.api('DELETE', `${root}/${first.workspace_id}/members/${member.id}`, actor));
    assert.deepEqual(await response(await readUser(w, member.id)), expected);
    await response(await w.api('POST', `${root}/${last.workspace_id}/close`, actor));
    await notFound(await readUser(w, member.id));

    // Even a stale admission row must fail the live workspace check.
    w.db.prepare("INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,'app',0,'workspace')").run(member.id);
    await notFound(await readUser(w, member.id));
});

test('profile reads give the same 404 for any unavailable subject', async t => {
    const w = await world(t), db = w.env.DB.db;
    db.exec("INSERT INTO realms(id,issuer,display_name,created) VALUES('acme','https://acme.example','Acme',0)");
    const addUser = db.prepare('INSERT INTO users(id,realm_id,email,status,merged_into,created) VALUES(?,?,?,?,?,0)');
    const admit = db.prepare('INSERT INTO client_admissions(user_id,client_id,created) VALUES(?,?,0)');
    const otherApp = 'other/app?#';
    addUser.run(otherApp, 'default', 'other-app@example.com', 'active', null);
    admit.run(otherApp, 'other');
    // Keep admissions on the unavailable rows so each account fence is tested independently.
    for (const [sub, realm, status, mergedInto] of [
        ['other-realm', 'acme', 'active', null],
        ['blocked', 'default', 'blocked', null],
        ['deleted', 'default', 'deleted', null],
        ['merged', 'default', 'active', otherApp]
    ]) {
        addUser.run(sub, realm, `${sub}@example.com`, status, mergedInto);
        admit.run(sub, 'app');
    }
    const otherResult = await w.call(userPath(otherApp), { headers: { authorization: basic('other') } });
    assert.deepEqual(await response(otherResult), { sub: otherApp, email: 'other-app@example.com', email_verified: false, name: null });
    for (const sub of ['unknown', otherApp, 'other-realm', 'blocked', 'deleted', 'merged'])
        await notFound(await readUser(w, sub));
    admit.run(otherApp, 'app');
    await response(await readUser(w, otherApp));
    db.prepare("DELETE FROM client_admissions WHERE user_id=? AND client_id='app'").run(otherApp);
    await notFound(await readUser(w, otherApp));
});

test('user lookup requires Basic app credentials, validates subjects and routes only GET', async t => {
    const w = await world(t);
    w.env.DB.db.prepare("UPDATE clients SET secret_hash=NULL WHERE id='other'").run();
    const keys = [];
    w.env.API_LIMITER.limit = async ({ key }) => { keys.push(key); return { success: true }; };
    const path = userPath('unknown');
    for (const [authorization, target] of [
        [basic('other', ''), path],
        [basic('app', 'wrong'), path],
        [undefined, path + '&client_id=app&client_secret=secret']
    ]) {
        const result = await w.call(target, { headers: authorization ? { authorization } : {} });
        assert.match(result.headers.get('www-authenticate'), /^Basic /);
        await error(result, 'invalid_client', 401);
    }
    const address = await sha256('ip:unavailable'), client = await sha256('client:app');
    const invalid = ['', '?sub=', '?sub=one&sub=two', '?sub=%00', `?sub=${'x'.repeat(201)}`];
    for (const suffix of invalid)
        await error(await w.call(endpoint + suffix, { headers: { authorization: basic() } }), 'invalid_request', 400);
    await notFound(await readUser(w, 'unknown'));
    const posted = await w.post(path, {}, '', { authorization: basic() });
    assert.deepEqual(await response(posted, 404), { error: 'not_found', error_description: 'Endpoint not found.' });
    assert.deepEqual(keys, [address, address, address, ...invalid.map(() => client), client, address]);
});
