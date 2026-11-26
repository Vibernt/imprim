import test from 'node:test';
import { useWebShell } from './support/web-shell.mjs';
import assert from 'node:assert/strict';
import { world, turnstile, cookieJar, login, basic } from './support/world.mjs';
// The sign-in page for an authorization request, read once: its markup, cookie and request id.
async function open(w, changes = {}, cookie = '') {
    const response = await w.authorize(changes, cookie), html = await response.text();
    return { response, html, cookie: cookieJar(response), request_id: html.match(/data-request-id="([^"]+)"/)?.[1] };
}
import { fireLabels } from './support/i18n.mjs';
import { adminLogin } from './support/admin.mjs';
import { catalogues, LANGUAGES } from '../apps/server/src/i18n/index.mjs';
import { forgetRealms } from '../apps/server/src/realms/realm.mjs';
const de = id => catalogues.get('de')[id], fr = id => catalogues.get('fr')[id];
const escaped = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const setRealmBranding = (w, branding) => { w.env.DB.db.prepare("UPDATE realms SET config=json_set(config,'$.branding',json(?)) WHERE id='default'").run(JSON.stringify(branding)); forgetRealms(w.env); };

test('Accept-Language picks the page language; <html lang> follows; unknown languages get English', async t => {
    const w = await world(t);
    const french = await (await w.call('/check-email', { headers: { 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.5' } })).text();
    assert.match(french, /<html lang="fr" data-fd-surface="app">/);
    assert.ok(french.includes(escaped(fr('Check your email'))));
    const unknown = await (await w.call('/check-email', { headers: { 'accept-language': 'it, ja;q=0.8' } })).text();
    assert.match(unknown, /<html lang="en" data-fd-surface="app">/);
    assert.ok(unknown.includes('Check your email'));
    const junk = await w.call('/check-email', { headers: { 'accept-language': '"><script>alert(1)</script>;q=1, ' + 'x'.repeat(5000) } });
    assert.equal(junk.status, 200);
    const html = await junk.text();
    assert.match(html, /<html lang="en" data-fd-surface="app">/); assert.ok(!html.includes('<script>alert'));
});
test('ui_locales on /authorize wins over the browser, is stored sanitized, and reaches the sign-in email', async t => {
    const w = await world(t); turnstile(t);
    const flow = await open(w, { ui_locales: '"><img src=x> de fr' });
    const html = flow.html;
    assert.match(html, /<html lang="de" data-fd-surface="app">/);
    assert.ok(html.includes(escaped(de('Email me a link'))));
    assert.ok(!html.includes('<img src=x>') && !html.includes('&lt;img src=x'), 'the value is never reflected');
    assert.equal(w.env.DB.db.prepare('SELECT ui_locales FROM auth_requests WHERE id=?').get(flow.request_id).ui_locales, 'de fr');
    await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, flow.cookie, { 'accept-language': 'fr' });
    await w.drain();
    const mail = w.mails.at(-1);
    assert.equal(mail.subject, de('Sign in to {name}').replace('{name}', 'Vibernt'));
    assert.ok(mail.text.startsWith(de('Open this link in the browser where you started, then choose Sign in. It expires in 15 minutes.')));
    assert.match(mail.html, /<html lang="de"/);
});
test('ui_locales with nothing usable falls through to the browser, then English', async t => {
    const w = await world(t);
    // Well-formed but unknown tags are kept (they are only preferences); anything else is dropped.
    for (const [value, stored] of [['"><script>', null], ['x'.repeat(600), null], ['xx yy zz', 'xx yy zz'], ['', null]]) {
        const flow = await open(w, { ui_locales: value });
        assert.match(flow.html, /<html lang="en" data-fd-surface="app">/, value);
        assert.equal(w.env.DB.db.prepare('SELECT ui_locales FROM auth_requests WHERE id=?').get(flow.request_id).ui_locales, stored, value);
    }
});
test('a brand that offers some languages only uses those; the default language applies when the browser asks for none', async t => {
    const w = await world(t);
    setRealmBranding(w, { locales: ['de', 'fr'], locale: 'de' });
    const english = await (await w.call('/check-email', { headers: { 'accept-language': 'en' } })).text();
    assert.match(english, /<html lang="de" data-fd-surface="app">/, 'English is not offered');
    const french = await (await w.call('/check-email', { headers: { 'accept-language': 'fr' } })).text();
    assert.match(french, /<html lang="fr" data-fd-surface="app">/);
    const discovery = await (await w.call('/.well-known/openid-configuration')).json();
    assert.deepEqual(discovery.ui_locales_supported, ['de', 'fr']);
    setRealmBranding(w, {});
    assert.deepEqual((await (await w.call('/.well-known/openid-configuration')).json()).ui_locales_supported, LANGUAGES);
});
test('per-language brand words show in that language; the default words stay with the default language', async t => {
    const w = await world(t);
    setRealmBranding(w, { copy: { signed_out: 'See you soon.' }, locale_copy: { de: { signed_out: 'Bis bald.' } } });
    assert.ok((await (await w.call('/signed-out')).text()).includes('See you soon.'));
    assert.ok((await (await w.call('/signed-out', { headers: { 'accept-language': 'de' } })).text()).includes('Bis bald.'));
    const french = await (await w.call('/signed-out', { headers: { 'accept-language': 'fr' } })).text();
    assert.ok(!french.includes('See you soon.') && french.includes(escaped(fr('Some apps keep you signed in until you sign out there.'))));
});
test('the saved language: chosen on the account page, checked, CSRF-bound, and used for pages and notices', async t => {
    const w = await world(t), { cookie } = await login(w, t);
    const csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const save = (locale, extra = {}, jar = cookie) => w.call('/account/language', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie: jar, ...extra }, body: new URLSearchParams({ csrf, locale }) });
    for (const bad of ['it', 'de"><x', 'en-XA', 'DE']) assert.equal((await save(bad)).status, 400, bad);
    assert.equal((await w.call('/account/language', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie }, body: new URLSearchParams({ csrf: 'wrong', locale: 'de' }) })).status, 403);
    assert.equal((await save('de', { origin: 'https://evil.example' })).status, 403);
    const saved = await save('de');
    assert.equal(saved.status, 200);
    assert.match(await saved.text(), /<html lang="de" data-fd-surface="app">/);
    assert.equal(w.env.DB.db.prepare("SELECT locale FROM users WHERE email='person@example.com'").get().locale, 'de');
    // The saved language beats the browser's, but not an app's ui_locales.
    const headers = { cookie, 'accept-language': 'fr' };
    assert.equal((await (await w.call('/v1/me', { headers })).json()).locale, 'de');
    assert.equal((await (await w.call('/v1/account/profile', { headers })).json()).locale, 'de');
    const flow = await open(w, { ui_locales: 'fr', prompt: 'login' }, cookie);
    assert.match(flow.html, /<html lang="fr" data-fd-surface="app">/);
    assert.equal((await save('')).status, 200);
    assert.equal(w.env.DB.db.prepare("SELECT locale FROM users WHERE email='person@example.com'").get().locale, null);
});
test('the admin console stays English whatever the browser asks', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    await useWebShell(t, w.env);
    const response = await w.call('/admin/clients', { headers: { cookie: admin.cookie, accept: 'text/html', 'accept-language': 'de' } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<html [^>]*lang="en"[^>]*>/);
    assert.equal(fireLabels(html)['menu.close'], 'Close menu');
    assert.match(html, /<app-shell><\/app-shell>/);
});
test('an administrator\'s two-factor reset notice goes in the person\'s language, not the administrator\'s', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const person = await login(w, t);
    const csrf = person.cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    await w.call('/account/language', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie: person.cookie }, body: new URLSearchParams({ csrf, locale: 'pt-BR' }) });
    const { enrolMfa } = await import('./support/admin.mjs');
    await enrolMfa(w, person.cookie, csrf); await w.drain();
    const id = w.env.DB.db.prepare("SELECT id FROM users WHERE email='person@example.com'").get().id;
    const reset = await admin.post(`users/${id}/reset-mfa`, { reason: 'Lost phone, verified by call' }, { 'accept-language': 'de' });
    assert.equal(reset.status, 200, await reset.clone().text()); await w.drain();
    const mail = w.mails.at(-1), pt = catalogues.get('pt-BR');
    assert.equal(mail.subject, `Vibernt: ${pt['your two-factor authentication was reset']}`);
    assert.ok(mail.text.startsWith(pt['An administrator reset two-factor authentication on your account (reason: {reason}). You were signed out and will set it up again at your next sign-in.'].replace('{reason}', 'Lost phone, verified by call')));
});
test('errors people read are translated; protocol errors stay English ASCII', async t => {
    const w = await world(t);
    const page = await (await w.call('/error', { headers: { accept: 'text/html', 'accept-language': 'de' } })).text();
    assert.ok(page.includes(escaped(de('This sign-in has expired'))));
    const unknown = await (await w.call('/authorize?client_id=nope', { headers: { accept: 'text/html', 'accept-language': 'fr' } })).text();
    assert.ok(unknown.includes(escaped(fr('Unknown client.'))));
    const json = await (await w.post('/v1/auth/magic/request', { email: 'a@example.com' }, '', { 'accept-language': 'de' })).json();
    assert.equal(json.error, 'browser_binding');
    assert.equal(json.error_description, de('Open the sign-in page first.'));
    const token = await (await w.call('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(), 'accept-language': 'de' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x' }) })).json();
    assert.match(token.error_description, /^[\x20-\x7e]+$/);
    assert.ok(!Object.values(catalogues.get('de')).includes(token.error_description));
});
test('page scripts come in the page language; English pages keep the plain script', async t => {
    const w = await world(t);
    assert.match(await (await w.call('/login')).text(), /<script src="\/assets\/sign-in.js" defer>/);
    assert.match(await (await w.call('/login', { headers: { 'accept-language': 'de' } })).text(), /<script src="\/assets\/sign-in.js\?lang=de" defer>/);
    const english = await (await w.call('/assets/sign-in.js')).text();
    assert.equal(await (await w.call('/assets/sign-in.js?lang=%22%3E%3C%2Fscript%3E')).text(), english);
    assert.equal(await (await w.call('/assets/sign-in.js?lang=it')).text(), english);
    const german = await (await w.call('/assets/sign-in.js?lang=de')).text();
    assert.ok(german.includes(JSON.stringify(de('Sign-in failed.'))) && !german.includes("'Sign-in failed.'"));
    assert.ok((await (await w.call('/assets/passkey.js?lang=fr')).text()).includes(JSON.stringify(fr('The passkey step didn’t finish. Try again.'))));
});
test('every shipped language renders the main pages without falling back to English text', async t => {
    const w = await world(t);
    for (const tag of LANGUAGES.filter(tag => tag !== 'en')) {
        const html = await (await w.call('/login', { headers: { 'accept-language': tag } })).text();
        assert.match(html, new RegExp(`<html lang="${tag}" data-fd-surface="app">`));
        assert.ok(!html.includes('>Email me a link<') && !html.includes('Administrators sign in by email.'), tag);
    }
});
