// The console's client editor: every setting has a control that fits its value, and the form posts no JSON a person
// had to type. The server reads lists as lines, switches as checked boxes and groups as one box per choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, turnstile } from './support/world.mjs';
import { adminLogin, assertFireMarkup } from './support/admin.mjs';
import { clientFromForm } from '../apps/server/src/admin/client-form.mjs';

const EDITOR = { editor: '1', id: 'notes', redirect_uris: 'https://notes.example/callback\nhttps://notes.example/silent\n', post_logout_uris: '', backchannel_uri: 'https://notes.example/backchannel',
    'sign_in_methods.passkey': '1', 'sign_in_methods.email': '1', signup_policy: 'open', allowed_domains: 'example.com', google_hosted_domains: '', mfa: 'optional', mfa_trusted_device_days: '30',
    agent_access: 'on', 'agent_registration_methods.metadata_document': '1', agent_scope_catalogue: '{"notes:read":"Read your notes","a=b":"Odd name"}',
    agent_resource_prefixes: 'https://notes.example/w/', agent_allowlist: '', agent_max_grant_days: '30', agent_dpop: 'required', token_exchange_from: '{"reports":"notes:read"}', branding: '{"name":"Notes"}' };

test('the editor form becomes the same object the API takes', () => {
    assert.deepEqual(clientFromForm(EDITOR), { id: 'notes', redirect_uris: ['https://notes.example/callback', 'https://notes.example/silent'], post_logout_uris: [],
        backchannel_uri: 'https://notes.example/backchannel', sign_in_methods: ['passkey', 'email'], signup_policy: 'open', allowed_domains: ['example.com'], google_hosted_domains: [],
        mfa: 'optional', mfa_trusted_device_days: 30, agent_access: 'on', agent_registration_methods: ['metadata_document'],
        agent_scope_catalogue: { 'notes:read': 'Read your notes', 'a=b': 'Odd name' }, agent_resource_prefixes: ['https://notes.example/w/'], agent_allowlist: [], agent_max_grant_days: 30,
        agent_dpop: 'required', token_exchange_from: { reports: ['notes:read'] }, branding: { name: 'Notes' },
        // Switches left off post nothing; a whole editor form says so.
        dev: 0, user_events: 'off', agent_consent_mfa: 'off', classic_oidc: 'off' });
});
test('without script the same form posts lines, and the server reads them the same way', () => {
    const plain = clientFromForm({ editor: '1', agent_scope_catalogue: 'notes:read = Read your notes\r\nnotes:write=Change your notes', token_exchange_from: 'reports = notes:read notes:write\n', redirect_uris: ' https://a.example/cb \r\n\r\nhttps://b.example/cb' });
    assert.deepEqual(plain.agent_scope_catalogue, { 'notes:read': 'Read your notes', 'notes:write': 'Change your notes' });
    assert.deepEqual(plain.token_exchange_from, { reports: ['notes:read', 'notes:write'] });
    assert.deepEqual(plain.redirect_uris, ['https://a.example/cb', 'https://b.example/cb']);
    assert.deepEqual(plain.sign_in_methods, [], 'an editor form with no method ticked saves none; the server then refuses it');
});
test('a post that is not the whole editor changes only the fields it names', () => {
    assert.deepEqual(clientFromForm({ version: '3', signup_policy: 'open' }), { version: 3, signup_policy: 'open' });
    assert.deepEqual(clientFromForm({ dev: '1', sign_in_methods: '["email","github"]', redirect_uris: '["https://a.example/cb"]' }), { dev: 1, sign_in_methods: ['email', 'github'], redirect_uris: ['https://a.example/cb'] });
});
test('malformed values are refused with a message a person can act on', () => {
    assert.throws(() => clientFromForm({ branding: '{"name":' }), error => error.code === 'invalid_request' && /branding isn’t valid JSON/.test(error.message));
    assert.throws(() => clientFromForm({ agent_scope_catalogue: 'no equals sign here' }), error => error.code === 'invalid_request' && /name = value/.test(error.message));
    assert.throws(() => clientFromForm({ redirect_uris: '["https://a.example/cb"' }), error => error.code === 'invalid_request');
});

test('legacy client editor POSTs still register and update the values returned by the JSON API', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    const data = await a.get('clients/editor/defaults');
    assert.equal(data.status, 200);
    const { defaults } = await data.json();
    assert.deepEqual(defaults.sign_in_methods, ['email']);
    assert.deepEqual(defaults.redirect_uris, []);
    assert.deepEqual(defaults.agent_scope_catalogue, {});
    assert.equal(defaults.signup_policy, 'invited');
    assert.equal(defaults.dev, 0);
    assert.equal(defaults.agent_max_grant_days, 90);
    const post = (path, fields, headers = {}) => w.call(path, { method: 'POST', headers: { origin: w.env.ISSUER, cookie: a.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ csrf: a.csrf, ...fields }) });
    const created = await post('/admin/clients', EDITOR);
    assert.equal(created.status, 200, await created.clone().text());
    const saved = await (await a.get('clients/notes')).json();
    assert.deepEqual(saved.sign_in_methods, ['passkey', 'email'], 'the order of the boxes is the order saved');
    assert.deepEqual([saved.dev, saved.agent_access, saved.agent_dpop, saved.user_events, saved.mfa_trusted_device_days], [0, 'on', 'required', 'off', 30]);
    assert.deepEqual(saved.token_exchange_from, { reports: ['notes:read'] });

    assert.deepEqual(saved.redirect_uris, ['https://notes.example/callback', 'https://notes.example/silent']);
    assert.deepEqual(saved.agent_scope_catalogue, { 'notes:read': 'Read your notes', 'a=b': 'Odd name' });
    assert.equal(saved.id, 'notes');
    assert.equal((await a.post('clients/notes', { id: 'renamed', version: saved.version })).status, 400);

    // Turning a switch off is an unchecked box: the editor form says the switch was there.
    const { agent_access: _on, id: _id, ...rest } = EDITOR;
    const updated = await post('/admin/clients/notes', { ...rest, version: String(saved.version) });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal((await (await a.get('clients/notes')).json()).agent_access, 'off');
});

test('a form the server refuses is explained in the console; the API still answers JSON', async t => {
    const w = await world(t); turnstile(t); const a = await adminLogin(w);
    const body = new URLSearchParams({ csrf: a.csrf, ...EDITOR, agent_resource_prefixes: '' });
    const headers = { origin: w.env.ISSUER, cookie: a.cookie, 'content-type': 'application/x-www-form-urlencoded' };
    const browser = await w.call('/admin/clients', { method: 'POST', headers: { ...headers, accept: 'text/html,application/xhtml+xml' }, body });
    assert.equal(browser.status, 400);
    const html = await browser.text();
    assertFireMarkup(html);
    assert.match(html, /<h1 class="fd-display">Not saved<\/h1>/);
    assert.match(html, /Enabled agent access needs scopes and resources\./);
    assert.match(html, /<a class="fd-btn" href="\/admin\/clients\/new" data-variant="outline">/);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM clients WHERE id='notes'").get().n, 0);
    // A script that does not ask for HTML gets the JSON error, as before.
    const script = await w.call('/admin/clients', { method: 'POST', headers, body });
    assert.equal(script.status, 400); assert.equal((await script.json()).error, 'invalid_request');
    // Someone who is not an administrator gets no console page, whatever they ask for.
    const outsider = await w.call('/admin/clients', { method: 'POST', headers: { ...headers, cookie: '', accept: 'text/html' }, body });
    assert.equal(outsider.status, 403); assert.ok(!(await outsider.text()).includes('fd-app'));
});
