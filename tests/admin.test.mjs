import test from 'node:test';
import { useWebShell } from './support/web-shell.mjs';
import assert from 'node:assert/strict';
import { world, turnstile, login } from './support/world.mjs';
import { adminLogin, clientConfig } from './support/admin.mjs';
import { ensureUser } from '../apps/server/src/services/admission.mjs';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { sha256 } from '../apps/server/src/lib/crypto.mjs';

for (const boundary of ['anonymous','non-admin','normal admin session','provider session','expired scope','roster removed','missing csrf','wrong csrf','missing origin','cross origin','stale authentication'])
    test(`admin mutation refuses ${boundary}`, async t => {
        const w = await world(t); turnstile(t); const a = await adminLogin(w);
        const user = await ensureUser(w.env, 'target@example.com'), headers = {};
        if (boundary === 'anonymous') headers.cookie = '';
        if (boundary === 'non-admin' || boundary === 'normal admin session' || boundary === 'provider session') {
            const person = await ensureUser(w.env, boundary === 'non-admin' ? 'person@example.com' : 'admin@example.com');
            const signed = await issueSession(w.env, person, boundary === 'provider session' ? 'github' : 'email');
            headers.cookie = signed.cookies.map(c => c.split(';')[0]).join('; ');
        }
        if (boundary === 'expired scope') w.env.DB.db.exec('UPDATE sessions SET admin_until=0');
        if (boundary === 'roster removed') w.env.DB.db.exec("DELETE FROM admins");
        if (boundary === 'missing csrf') headers['x-csrf-token'] = '';
        if (boundary === 'wrong csrf') headers['x-csrf-token'] = 'wrong';
        if (boundary === 'missing origin') headers.origin = '';
        if (boundary === 'cross origin') headers.origin = 'https://evil.example';
        if (boundary === 'stale authentication') w.env.DB.db.exec('UPDATE sessions SET auth_time=0');
        const response = await a.post(`users/${user.id}/block`, {}, headers);
        assert.equal(response.status, boundary === 'anonymous' ? 401 : 403, await response.text());
        assert.equal(w.env.DB.db.prepare('SELECT status FROM users WHERE id=?').get(user.id).status, 'active');
        assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_block'").get().n, 0);
    });

test('client create/edit/secret rotation audit and show-once secret; HTML screens have strict CSP/no-store', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    const created = await a.post('clients', clientConfig); assert.equal(created.status, 200, await created.clone().text());
    const first = await created.json(); assert.ok(first.client_secret);
    assert.equal(w.env.DB.db.prepare('SELECT secret_hash FROM clients WHERE id=?').get(clientConfig.id).secret_hash, await sha256(first.client_secret));
    const edit = { redirect_uris: ['https://notes.example/new'], post_logout_uris: ['https://notes.example/out'],
        backchannel_uri: 'https://notes.example/logout', sign_in_methods: ['google','email'], branding: { name: '<script>bad</script>' },
        signup_policy: 'open', agent_access: 'on', agent_resource_prefixes: ['https://notes.example/w/'], agent_scope_catalogue: { read: 'Read' } };
    assert.equal((await a.post('clients/notes', { ...edit, version: first.client.version })).status, 200);
    const rotated = await a.post('clients/notes/rotate-secret'), second = await rotated.json();
    assert.notEqual(first.client_secret, second.client_secret);
    assert.equal(w.env.DB.db.prepare('SELECT secret_hash FROM clients WHERE id=?').get(clientConfig.id).secret_hash, await sha256(second.client_secret));
    for (const path of ['clients','clients/notes','audit','keys','settings']) {
        const response = await a.get(path), text = await response.text(); assert.equal(response.status, 200, text);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        for (const secret of [first.client_secret, second.client_secret, await sha256(second.client_secret)]) assert.ok(!text.includes(secret));
    }
    await useWebShell(t, w.env);
    for (const path of ['/admin','/admin/clients','/admin/clients/new','/admin/clients/notes','/admin/users','/admin/audit','/admin/keys','/admin/settings']) {
        const response = await w.call(path, { headers: { cookie: a.cookie, accept: 'text/html' } });
        assert.equal(response.status, 200, path); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        const html = await response.text();
        assert.ok(!html.includes('<script>bad</script>'));
        assert.match(html, /<app-shell><\/app-shell>/);
    }
    const events = w.env.DB.db.prepare("SELECT * FROM audit WHERE event LIKE 'admin_%'").all();
    assert.deepEqual(events.map(r => r.event), ['admin_sign_in','admin_client_create','admin_client_update','admin_client_secret_rotate']);
    for (const event of events) assert.ok(event.actor && event.target);
    const detail = JSON.parse(events[2].detail);
    for (const field of ['redirect_uris','post_logout_uris','backchannel_uri']) assert.ok(detail.fields.includes(field));
    assert.throws(() => w.env.DB.db.exec("UPDATE audit SET target='x'"), /append-only/);
    assert.throws(() => w.env.DB.db.exec('DELETE FROM audit'), /append-only/);
});

for (const input of [{ redirect_uris: ['javascript:alert(1)'] }, { backchannel_uri: null }, { backchannel_uri: 'http://localhost/logout' },
    { signup_policy: 'anything' }, { sign_in_methods: [] }, { sign_in_methods: ['email','email'] }, { agent_access: 'on' },
    { secret_hash: 'a'.repeat(64) }, { client_secret: 'secret' }, { id: 'renamed' }, { branding: { logo: 'bad' } }])
    test(`admin refuses invalid client update ${JSON.stringify(input)}`, async t => {
        const w = await world(t); turnstile(t); const a = await adminLogin(w);
        await a.post('clients', clientConfig);
        assert.equal((await a.post('clients/notes', { ...input, version: 0 })).status, 400);
        assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_client_update'").get().n, 0);
    });

test('audit cursor/filter and user search/detail; settings are read-only', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    const user = await ensureUser(w.env, 'find@example.com');
    for (let n = 0; n < 55; n++) await a.post(`users/${user.id}/${n % 2 ? 'unblock' : 'block'}`);
    const first = await (await a.get('audit?target=' + user.id)).json(); assert.equal(first.audit.length, 50); assert.ok(first.next);
    const next = await (await a.get(`audit?target=${user.id}&before=${first.next}`)).json(); assert.equal(next.audit.length, 5);
    assert.ok(first.audit[0].id > first.audit.at(-1).id && first.audit.at(-1).id > next.audit[0].id);
    assert.equal((await (await a.get('audit?actor=not-an-actor')).json()).audit.length, 0);
    assert.equal((await (await a.get('users?q=find%40')).json()).users[0].id, user.id);
    assert.equal((await (await a.get('users/' + user.id)).json()).email, 'find@example.com');
    assert.equal((await a.post('settings', { turnstile: false })).status, 404);
});

test('normal app magic login does not elevate an administrator', async t => {
    const w = await world(t), signed = await login(w, t, 'admin@example.com');
    assert.equal((await w.call('/admin/api/clients', { headers: { cookie: signed.cookie } })).status, 403);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_sign_in'").get().n, 0);
});

test('HTML client forms submit JSON fields and never redisplay a secret', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    const body = new URLSearchParams({ csrf: a.csrf, ...clientConfig, redirect_uris: JSON.stringify(clientConfig.redirect_uris),
        post_logout_uris: JSON.stringify(clientConfig.post_logout_uris), branding: JSON.stringify(clientConfig.branding), dev: '0',
        sign_in_methods: '["email"]', google_hosted_domains: '[]', allowed_domains: '[]', agent_access: 'off',
        agent_registration_methods: '["metadata_document"]', agent_allowlist: '[]', agent_scope_catalogue: '{}', agent_resource_prefixes: '[]', agent_max_grant_days: '90' });
    const response = await w.call('/admin/clients', { method: 'POST', headers: { origin: w.env.ISSUER, cookie: a.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(response.status, 200, await response.clone().text()); assert.match(await response.text(), /Copy the new client secret now/);
    const get = await a.get('clients/notes');
    assert.equal(get.status, 200);
    assert.ok(!Object.hasOwn(await get.json(), 'client_secret'));
});

for (const endpoint of ['clients','clients/app','clients/app/rotate-secret','keys/rotate','users/target/block'])
    test(`admin ${endpoint} rejects absent CSRF and foreign Origin before any action`, async t => {
        const w = await world(t); turnstile(t); const a = await adminLogin(w);
        for (const headers of [{ 'x-csrf-token': '' }, { origin: 'https://evil.example' }]) assert.equal((await a.post(endpoint, clientConfig, headers)).status, 403);
    });

test('all admin read APIs refuse a non-admin and do not leak data', async t => {
    const w = await world(t), signed = await login(w, t);
    for (const path of ['clients','users','audit','keys','settings']) {
        const response = await w.call('/admin/api/' + path, { headers: { cookie: signed.cookie } });
        assert.equal(response.status, 403); assert.ok(!(await response.text()).includes('secret_hash'));
    }
});
