import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminLogin } from './support/admin.mjs';
import { login, turnstile, world } from './support/world.mjs';

const reads = [
    'workspaces', 'workspaces/example', 'workspaces/example/close', 'branding', 'settings', 'keys', 'realms'
];
const writes = [
    'workspaces', ...['rename', 'products', 'invite', 'revoke-invitation', 'role', 'remove-member', 'close']
        .map(action => 'workspaces/example/' + action),
    'branding', 'branding/assets', 'keys/rotate', 'keys/example/revoke', 'realms', 'realms/default', 'realms/default/admins'
];
const onlyPlatform = path => /^(keys|realms)(\/|$)/.test(path);

async function problem(response, status, error, path) {
    assert.equal(response.status, status, path + ': ' + await response.clone().text());
    const body = await response.json();
    assert.equal(body.error, error, path);
    assert.equal(typeof body.error_description, 'string', path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
}

test('admin realm APIs enforce session, roster, scope, MFA, Origin, CSRF, freshness and platform role', async t => {
    const w = await world(t);
    const person = await login(w, t);
    const admin = await adminLogin(w), db = w.env.DB.db;
    const tests = [...reads.map(path => [path, 'GET']), ...writes.map(path => [path, 'POST'])];
    const request = (path, method, cookie, overrides = {}) => {
        const headers = new Headers({ cookie, accept: 'application/json' });
        if (method === 'POST') {
            headers.set('origin', w.env.ISSUER);
            headers.set('content-type', 'application/json');
            headers.set('x-csrf-token', admin.csrf);
        }
        for (const [name, value] of Object.entries(overrides)) {
            if (value === null) headers.delete(name);
            else headers.set(name, value);
        }
        return w.call('/admin/api/' + path, { method, headers, body: method === 'POST' ? '{}' : undefined });
    };
    for (const [path, method] of tests) {
        await problem(await request(path, method, ''), 401, 'login_required', path);
        await problem(await request(path, method, person.cookie), 403, 'admin_required', path);
    }

    const adminScope = db.prepare('SELECT admin_until FROM sessions WHERE admin_until IS NOT NULL').get().admin_until;
    db.exec('UPDATE sessions SET admin_until=0 WHERE admin_until IS NOT NULL');
    for (const [path, method] of tests) await problem(await request(path, method, admin.cookie), 403, 'reauth_required', path);
    db.prepare('UPDATE sessions SET admin_until=?,mfa_at=0 WHERE admin_until IS NOT NULL').run(adminScope);
    for (const [path, method] of tests) await problem(await request(path, method, admin.cookie), 403, 'mfa_required', path);
    db.prepare('UPDATE sessions SET mfa_at=? WHERE admin_until IS NOT NULL').run(Date.now());

    for (const path of writes) {
        for (const csrf of [null, 'wrong']) await problem(await request(path, 'POST', admin.cookie, { 'x-csrf-token': csrf }), 403, 'csrf', path);
        await problem(await request(path, 'POST', admin.cookie, { origin: 'https://other.example' }), 403, 'origin', path);
        await problem(await request(path, 'POST', admin.cookie, { origin: null }), 403, 'origin', path);
    }
    db.exec('UPDATE sessions SET auth_time=auth_time-601 WHERE admin_until IS NOT NULL');
    for (const path of writes) await problem(await request(path, 'POST', admin.cookie), 403, 'reauth_required', path);
    db.exec("UPDATE sessions SET auth_time=auth_time+601 WHERE admin_until IS NOT NULL; UPDATE admins SET role='realm'");
    for (const [path, method] of tests.filter(([path]) => onlyPlatform(path))) {
        await problem(await request(path, method, admin.cookie), 403, 'admin_required', path);
    }
    assert.deepEqual(db.prepare("SELECT event FROM audit WHERE event LIKE 'admin_%'").all().map(row => row.event), ['admin_sign_in']);
});

test('platform APIs list, create and update realms and change the roster with version and self guards', async t => {
    turnstile(t);
    const w = await world(t), admin = await adminLogin(w);
    const create = { id: 'example', display_name: 'Example', issuer: 'https://id.example.test', config: { workspaces: 'on' } };
    await problem(await admin.post('realms', { ...create, issuer: 'https://id.example.test/path' }), 400, 'invalid_request', 'create');
    await problem(await admin.post('realms', { ...create, config: [] }), 400, 'realm_config', 'config');
    const result = await admin.post('realms', create);
    assert.equal(result.status, 200, await result.clone().text());
    const { realm } = await result.json();
    assert.equal(realm.id, 'example');
    await problem(await admin.post('realms', create), 409, 'conflict', 'duplicate');
    await problem(await admin.post('realms/missing', { version: 0 }), 404, 'not_found', 'unknown realm');
    const change = await admin.post('realms/example', { version: realm.version, display_name: 'Renamed' });
    assert.equal(change.status, 200, await change.clone().text());
    await problem(await admin.post('realms/example', { version: realm.version, display_name: 'Stale' }), 409, 'conflict', 'update');
    const { realms } = await (await admin.get('realms')).json();
    const ownAsset = await (await admin.post('branding/assets', { content_type: 'image/png', data: 'iVBORw0KGgo=' })).json();
    await problem(await admin.post('realms/example', { version: realm.version + 1, config: { branding: { logo_light: ownAsset.id } } }),
        400, 'branding', 'realm cannot reuse another realm’s asset');
    const current = realms.find(row => row.id === 'default');
    await problem(await admin.post('realms/default', { version: current.version, status: 'disabled' }), 400, 'invalid_request', 'current realm');
    await problem(await admin.post('realms/default/admins', { email: 'admin@example.com', role: null }), 400, 'invalid_request', 'self');
    await problem(await admin.post('realms/example/admins', { email: 'wrong', role: 'realm' }), 400, 'invalid_request', 'email');
    await problem(await admin.post('realms/example/admins', { email: 'team@example.net', role: 'owner' }), 400, 'invalid_request', 'role');
    assert.deepEqual(await (await admin.post('realms/example/admins', { email: 'TEAM@example.net', role: 'realm' })).json(),
        { realm: 'example', email: 'team@example.net', role: 'realm' });
    assert.deepEqual((await (await admin.get('realms')).json()).realms.find(row => row.id === realm.id).admins,
        [{ email: 'team@example.net', role: 'realm' }]);
    assert.equal((await admin.post('realms/example/admins', { email: 'team@example.net', role: null })).status, 200);
    const updated = (await (await admin.get('realms')).json()).realms.find(row => row.id === realm.id);
    assert.deepEqual([updated.display_name, updated.version, updated.config, updated.admins], ['Renamed', realm.version + 1, create.config, []]);
});

test('signing-key APIs rotate both algorithms, guard pending rotation and reject a foreign key', async t => {
    turnstile(t);
    const w = await world(t), admin = await adminLogin(w), db = w.env.DB.db;
    const result = await admin.get('keys');
    assert.equal(result.status, 200);
    const { keys: original } = await result.json();
    assert.deepEqual(original.map(key => key.alg), ['ES256', 'RS256']);
    assert.ok(original.every(key => !Object.hasOwn(key, 'sealed_jwk') && !Object.hasOwn(key, 'public_jwk')));
    const rotation = await admin.post('keys/rotate');
    assert.equal(rotation.status, 200, await rotation.clone().text());
    const { kid } = await rotation.json();
    const { keys } = await (await admin.get('keys')).json();
    assert.deepEqual(keys.filter(key => key.status === 'published').map(key => key.alg), ['ES256', 'RS256']);
    assert.ok(keys.some(key => key.kid === kid && key.status === 'published'));
    await problem(await admin.post('keys/rotate'), 409, 'rotation_pending', 'rotate');
    await problem(await admin.post(`keys/${'x'.repeat(101)}/revoke`), 400, 'invalid_request', 'kid size');
    db.exec(`INSERT INTO realms(id,issuer,display_name,config,created) VALUES('foreign','https://foreign.test','Foreign','{}',0);
        INSERT INTO signing_keys(realm_id,alg,generation,kid,public_jwk,sealed_jwk,created_at,activates_at)
        VALUES('foreign','ES256',1,'foreign-kid','{}','{}',0,0);`);
    await problem(await admin.post('keys/foreign-kid/revoke'), 404, 'not_found', 'foreign');
    const revoked = await admin.post('keys/' + kid + '/revoke');
    assert.deepEqual(await revoked.json(), { kid, revoked: true, removed_from_jwks: true });
    await problem(await admin.post('keys/' + kid + '/revoke'), 400, 'invalid_request', 'already revoked');
    assert.ok(!(await (await w.call('/.well-known/jwks.json')).json()).keys.some(key => key.kid === kid));
});

test('realm writes fail the batch and leave no audit or mutation when the authenticating session changes', async t => {
    turnstile(t);
    const w = await world(t), admin = await adminLogin(w), db = w.env.DB.db;
    await admin.get('keys');
    const { version } = await (await admin.get('branding')).json();
    const snapshot = () => ['realms', 'admins', 'brand_assets', 'signing_keys', 'audit'].map(table => db.prepare('SELECT count(*) AS n FROM ' + table).get().n);
    const counts = snapshot();
    const batch = w.env.DB.batch.bind(w.env.DB);
    const scope = db.prepare('SELECT admin_until value FROM sessions WHERE admin_until IS NOT NULL').get().value;
    t.mock.method(w.env.DB, 'batch', async statements => {
        db.exec('UPDATE sessions SET admin_until=0 WHERE admin_until IS NOT NULL');
        return batch(statements);
    });
    const logo = { content_type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>').toString('base64') };
    for (const [path, body] of [
        ['branding', { version, branding: { name: 'Denied' } }], ['branding/assets', logo],
        ['realms', { id: 'denied', issuer: 'https://denied.test', display_name: 'Denied' }],
        ['realms/default/admins', { email: 'another@example.net', role: 'realm' }], ['keys/rotate', {}]
    ]) {
        db.prepare('UPDATE sessions SET admin_until=? WHERE admin_until IS NOT NULL').run(scope);
        await problem(await admin.post(path, body), 409, 'conflict', path);
        assert.deepEqual(snapshot(), counts);
    }
});

test('settings and the sample email expose the saved realm and no secrets, mail sends or authentication link', async t => {
    turnstile(t);
    const w = await world(t), admin = await adminLogin(w);
    const settings = await (await admin.get('settings')).json();
    assert.equal(settings.realm.id, 'default');
    assert.equal(settings.role, 'platform');
    assert.ok(['off', 'on', 'misconfigured'].includes(settings.turnstile));
    assert.match(settings.rate_limits, /AUTH_LIMITER/);
    assert.deepEqual(Object.keys(settings.delivery).sort(), ['agent', 'clients_missing_backchannel', 'human', 'user_events', 'workspace_events']);
    assert.doesNotMatch(JSON.stringify(settings), /TURNSTILE_SECRET|EMAIL_SECRET|sealed_jwk/);
    const logo = await admin.post('branding/assets', { content_type: 'image/png', data: 'iVBORw0KGgo=' });
    assert.equal(logo.status, 200, await logo.clone().text());
    const { id } = await logo.json();
    const { version } = await (await admin.get('branding')).json();
    assert.equal((await admin.post('branding', { version, branding: { name: 'Example <brand>', logo_light: id } })).status, 200);
    const mailCount = w.mails.length;
    const cookie = { cookie: admin.cookie };
    const preview = await w.call('/admin/branding/email-preview', { headers: cookie });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-security-policy'), /sandbox; default-src 'none'/);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.equal(preview.headers.get('x-robots-tag'), 'noindex');
    const html = await preview.text();
    assert.match(html, /Sign in to Example &lt;brand&gt;/);
    assert.match(html, /src="data:image\/png;base64,iVBORw0KGgo="/);
    assert.match(html, /href="#sample"/);
    assert.doesNotMatch(html, /#token=|<script/);
    assert.equal(w.mails.length, mailCount);
    assert.equal((await w.call('/admin/branding/email-preview')).status, 303);
});
