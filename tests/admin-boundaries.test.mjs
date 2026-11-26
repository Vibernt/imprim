import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, metadataId, resource } from './support/agents.mjs';
import { adminLogin, clientConfig } from './support/admin.mjs';
import { cookieJar, world, turnstile, login, begin } from './support/world.mjs';
import { signingKey } from '../apps/server/src/oidc/keys.mjs';
import { completeAuthorization } from '../apps/server/src/oidc/requests.mjs';
import { providerIdentity } from '../apps/server/src/auth/provider-identity.mjs';
import { getClient } from '../apps/server/src/oidc/clients.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';

for (const kind of ['agent code','refresh','approved device','pending consent','pending device']) test(`admin block refuses ${kind}, including after unblock of a revoked grant`, async t => {
    const w = await agentWorld(t), a = await adminLogin(w); let run;
    if (kind === 'agent code') { const flow = await w.start(), response = await w.approve(flow); const code = new URL(response.headers.get('location')).searchParams.get('code'); run = () => w.exchange(code); }
    if (kind === 'refresh') { const { tokens } = await w.grant(); run = () => w.refresh(tokens.refresh_token); }
    if (kind === 'pending consent') { const flow = await w.start(); run = () => w.approve(flow); }
    if (kind.includes('device')) {
        const device = await (await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' })).json();
        const page = await w.call('/device?user_code=' + device.user_code, { headers: { cookie: w.cookie } });
        const flow = { id: new URL(page.headers.get('location')).searchParams.get('request_id'), cookie: w.cookie + '; ' + cookieJar(page), scopes: ['read'] };
        if (kind === 'approved device') {
            await w.approve(flow); w.env.DB.db.exec('UPDATE agent_devices SET next_poll=0');
            run = () => w.form('/token', { client_id: metadataId, resource, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code });
        } else run = () => w.approve(flow);
    }
    assert.equal((await a.post(`users/${w.user.id}/block`)).status, 200);
    assert.ok((await run()).status >= 400);
    assert.equal((await a.post(`users/${w.user.id}/unblock`)).status, 200);
    assert.ok((await run()).status >= 400);
});

test('block refuses magic login, human code, userinfo, SSO, pending authorization and upstream providers', async t => {
    const w = await world(t), signed = await login(w, t), a = await adminLogin(w);
    const user = w.env.DB.db.prepare("SELECT * FROM users WHERE email='person@example.com'").get();
    const session = w.env.DB.db.prepare('SELECT * FROM sessions WHERE user_id=?').get(user.id);
    const app = await getClient(w.env, 'app');
    const secondCode = await w.authorize({}, signed.cookie), code = new URL(secondCode.headers.get('location')).searchParams.get('code');
    const tokens = await (await w.exchange(signed.code)).json();
    const pending = await begin(w);
    await w.post('/v1/auth/magic/request', { email: user.email, request_id: pending.request_id, turnstile: crypto.randomUUID() }, pending.cookie); await w.drain();
    const magic = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    assert.equal((await a.post(`users/${user.id}/block`)).status, 200);
    assert.ok((await w.post('/v1/auth/magic/verify', { token: magic }, pending.cookie)).status >= 400);
    assert.equal((await w.exchange(code)).status, 400);
    assert.equal((await w.call('/userinfo', { headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 401);
    const sso = await w.authorize({ prompt: 'none' }, signed.cookie); assert.equal(new URL(sso.headers.get('location')).searchParams.get('error'), 'login_required');
    await assert.rejects(completeAuthorization(w.env, new Request(w.env.ISSUER, { headers: { cookie: pending.cookie } }), pending.request_id, session), /Account unavailable/);
    for (const provider of ['github','google']) await assert.rejects(providerIdentity(w.env, app, provider, { providerId: provider + '-id', email: user.email }), /Account unavailable/);
    const mailCount = w.mails.length;
    await w.post('/v1/auth/magic/request', { email: user.email, request_id: pending.request_id, turnstile: crypto.randomUUID() }, pending.cookie); await w.drain();
    assert.equal(w.mails.length, mailCount);
});

test('admin authorization is checked again inside the mutation transaction', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w), original = w.env.DB.batch;
    w.env.DB.batch = async statements => { w.env.DB.db.exec('DELETE FROM sessions'); w.env.DB.batch = original; return original(statements); };
    assert.equal((await a.post('clients', clientConfig)).status, 409);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM clients WHERE id='notes'").get().n, 0);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_client_create'").get().n, 0);
});

test('merge rechecks provider conflict inside the transaction', async t => {
    const w = await agentWorld(t), a = await adminLogin(w), target = await ensureUser(w.env, 'survivor@example.com');
    w.env.DB.db.prepare('INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES(?,?,?,?,?)').run('github','first',w.user.id,null,Date.now());
    const original = w.env.DB.batch;
    w.env.DB.batch = async statements => {
        w.env.DB.db.prepare('INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES(?,?,?,?,?)').run('github','concurrent',target.id,null,Date.now());
        w.env.DB.batch = original; return original(statements);
    };
    assert.equal((await a.post(`users/${w.user.id}/merge`, { surviving_id: target.id, confirm_source_email: w.user.email })).status, 409);
    assert.equal(w.env.DB.db.prepare('SELECT status FROM users WHERE id=?').get(w.user.id).status, 'active');
});

test('human issuance refuses a user blocked between validation/signing and credential commit', async t => {
    const w = await world(t), signed = await login(w, t); await signingKey(w.env);
    const original = w.env.DB.batch; let batches = 0;
    w.env.DB.batch = async statements => {
        if (++batches === 2) w.env.DB.db.exec("UPDATE users SET status='blocked'");
        return original(statements);
    };
    assert.equal((await w.exchange(signed.code)).status, 400);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM access_tokens').get().n, 0);
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM app_sessions').get().n, 0);
});
