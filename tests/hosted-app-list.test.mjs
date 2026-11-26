import assert from 'node:assert/strict';
import test from 'node:test';
import { yourApps } from '../apps/server/src/pages/app-list.mjs';
import { clientSeedSql } from '../scripts/seed-client.mjs';
import { adminLogin, assertFireMarkup, clientConfig } from './support/admin.mjs';
import { addTeam, joinWorld } from './support/workspace-join.mjs';
import { begin, cookieJar, turnstile, world } from './support/world.mjs';

const launch = 'https://app.example.com/start';
const browse = (w, path, cookie = '', extra = {}) => w.call(path, { headers: { accept: 'text/html', cookie, ...extra } });
const links = html => [...html.matchAll(/class="fd-list-link" href="([^"]+)"/g)].map(match => match[1]);
const target = (db, id, { href = launch, listed = 1, branding = {} } = {}) =>
    db.prepare('UPDATE clients SET initiate_login_uri=?,listed=?,branding=? WHERE id=?').run(href, listed, JSON.stringify(branding), id);
const admit = (db, user, client, source = 'app') =>
    db.prepare('INSERT INTO client_admissions(user_id,client_id,created,source) VALUES(?,?,0,?)').run(user, client, source);

test('personal apps share live admission rules and rank by newest app session, then name', async t => {
    const w = await joinWorld(t), { user, cookie } = await w.person();
    const mark = 'a'.repeat(64);
    target(w.db, 'app', { listed: 0, branding: { name: 'Zebra', mark, summary: 'Notes', locale_copy: { fr: { summary: 'Vos notes' } } } });
    target(w.db, 'other', { href: 'https://other.example.com/start', branding: { name: 'Alpha' } });
    admit(w.db, user.id, 'app', 'workspace');
    admit(w.db, user.id, 'other');
    assert.deepEqual((await yourApps(w.env, user.id)).map(app => app.id), ['other']);
    addTeam(w.db, 'team', user.id);
    assert.deepEqual((await yourApps(w.env, user.id)).map(app => app.id), ['other', 'app']);
    w.db.prepare("INSERT INTO app_sessions(client_id,user_id,sid,created) VALUES('app',?,'old',1),('app',?,'new',2)").run(user.id, user.id);
    const page = await browse(w, '/signed-in', cookie, { 'accept-language': 'fr' });
    assert.equal(page.status, 200);
    const html = await page.text();
    assertFireMarkup(html);
    assert.deepEqual(links(html), [launch, 'https://other.example.com/start']);
    assert.match(html, /Vos applications/);
    assert.match(html, /Vos notes/);
    assert.match(html, new RegExp(`/assets/brand/${mark}`));
    const publicPage = await (await browse(w, '/signed-out', cookie)).text();
    assert.deepEqual(links(publicPage), ['https://other.example.com/start']);
    assert.match(publicPage, /<p class="fd-body">Some apps keep you signed in until you sign out there/);
    assert.deepEqual(links(await (await browse(w, '/account')).text()), ['https://other.example.com/start']);
    assert.doesNotMatch(await (await browse(w, '/login')).text(), /Zebra/);
    w.db.exec("UPDATE workspaces SET status='closed' WHERE id='team'");
    assert.deepEqual((await yourApps(w.env, user.id)).map(app => app.id), ['other']);
    w.db.exec("UPDATE users SET status='blocked'");
    assert.deepEqual(await yourApps(w.env, user.id), []);
});

test('personal app limit applies after live, realm-scoped filtering', async t => {
    const w = await joinWorld(t), { user } = await w.person();
    w.db.exec("INSERT INTO realms(id,issuer,display_name,created) VALUES('foreign','https://foreign.example.com','Foreign',0)");
    const put = w.db.prepare(`INSERT INTO clients(id,redirect_uris,initiate_login_uri,realm_id) VALUES(?,'[]',?,?)`);
    for (let n = 0; n < 15; n++) {
        const id = `app-${String(n).padStart(2, '0')}`;
        put.run(id, `https://app.example.com/${n}`, n === 0 ? 'foreign' : 'default');
        admit(w.db, user.id, id);
    }
    assert.deepEqual((await yourApps(w.env, user.id)).map(app => app.href),
        Array.from({ length: 12 }, (_, i) => `https://app.example.com/${i + 1}`));
});

test('skips only with one personal app, and the error loop guard is app-specific and expires', async t => {
    const w = await joinWorld(t), { user, cookie } = await w.person();
    target(w.db, 'app', { listed: 0 });
    assert.equal((await browse(w, '/signed-in', cookie)).status, 200);
    assert.equal((await browse(w, '/error', cookie)).status, 400);
    admit(w.db, user.id, 'app');
    const signedIn = await browse(w, '/signed-in', cookie);
    const skipCookie = cookieJar(signedIn);
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get('location'), launch);
    assert.match(signedIn.headers.get('set-cookie'), /^__Host-vi_app_skip=.*Secure.*Max-Age=60.*HttpOnly/);
    // An administrator lands here from /login on the way to the console: never skipped away from its link.
    w.db.prepare("INSERT INTO admins(realm_id,email,role,created) VALUES('default',?,'realm',0)").run(user.email);
    const admin = await browse(w, '/signed-in', cookie);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /Open the admin console/);
    w.db.prepare('DELETE FROM admins WHERE email=?').run(user.email);
    const expiredRequest = await begin(w, '', { client_id: 'app' });
    w.db.prepare('UPDATE auth_requests SET expires_at=0 WHERE id=?').run(expiredRequest.request_id);
    const expiredPath = `/error?request_id=${expiredRequest.request_id}`;
    assert.equal((await browse(w, expiredPath, cookie)).headers.get('location'), launch);
    const held = await browse(w, expiredPath, `${cookie}; ${expiredRequest.cookie}; ${skipCookie}`);
    assert.equal(held.status, 400);
    assert.match(await held.text(), /This sign-in has expired/);
    const stale = skipCookie.replace(/\.\d+$/, `.${Date.now() - 61000}`);
    assert.equal((await browse(w, '/error', `${cookie}; ${stale}`)).headers.get('location'), launch);
    assert.equal((await browse(w, '/error')).status, 400);
    assert.equal((await browse(w, '/signed-out', cookie)).status, 200);
    assert.equal((await browse(w, '/device?user_code=BBBB-BBBB', cookie)).status, 400);
    assert.equal((await browse(w, '/unknown', cookie)).status, 404);
    target(w.db, 'other', { href: 'https://other.example.com/start' });
    admit(w.db, user.id, 'other');
    assert.equal((await browse(w, '/signed-in', cookie)).status, 200);
    assert.equal((await browse(w, '/error', cookie)).status, 400);
    w.db.exec("DELETE FROM client_admissions WHERE client_id='app'");
    assert.equal((await browse(w, '/error', `${cookie}; ${skipCookie}`)).headers.get('location'), 'https://other.example.com/start');
});

test('client API and seed keep listed boolean with app-only, translated plain-text summaries', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const config = { ...clientConfig, listed: false, branding: { name: 'Notes', summary: 'Notes for teams', locale_copy: { 'pt-BR': { summary: 'Notas para equipes' } } } };
    const created = await admin.post('clients', config);
    assert.equal(created.status, 200, await created.clone().text());
    const { client } = await created.json();
    assert.equal(client.listed, false);
    assert.equal(client.branding.summary, 'Notes for teams');
    assert.equal((await (await admin.get('clients/notes')).json()).listed, false);
    const updated = await admin.post('clients/notes', { version: client.version, listed: true });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal((await updated.json()).client.listed, true);
    const invalid = [
        { listed: 1 }, { listed: 'false' }, { listed: null },
        { branding: { summary: 'x'.repeat(81) } }, { branding: { summary: '<b>Notes</b>' } }, { branding: { summary: ' ' } },
        { branding: { locale_copy: { ja: { summary: 'Notes' } } } },
        { branding: { locale_copy: { es: { summary: '<em>Notas</em>' } } } },
        { branding: { locale_copy: { es: { summary: 'x'.repeat(81) } } } }
    ];
    for (const [i, change] of invalid.entries()) {
        const payload = { ...config, id: `invalid-${i}`, ...change };
        assert.equal((await admin.post('clients', payload)).status, 400, JSON.stringify(change));
        assert.throws(() => clientSeedSql({ ...payload, secret_hash: null, sign_in_methods: ['email'] }));
    }
    const db = w.env.DB.db;
    db.exec(clientSeedSql({ ...config, id: 'hidden-seed', secret_hash: null, sign_in_methods: ['email'] }));
    db.exec(clientSeedSql({ ...clientConfig, id: 'default-seed', secret_hash: null, sign_in_methods: ['email'] }));
    assert.equal(db.prepare("SELECT listed FROM clients WHERE id='hidden-seed'").get().listed, 0);
    assert.equal(db.prepare("SELECT listed FROM clients WHERE id='default-seed'").get().listed, 1);
    assert.throws(() => db.exec("UPDATE clients SET listed=2 WHERE id='app'"), /CHECK/);
});
