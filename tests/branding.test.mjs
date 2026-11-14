// Branding: tokens with contrast checks, theme stylesheet, assets with SVG safety, branded pages and emails, editor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, begin, login, turnstile } from './support/world.mjs';
import { adminLogin } from './support/admin.mjs';
import { validateBranding, resolveBranding, assertContrast, contrast } from '../apps/server/src/branding/tokens.mjs';
import { checkAsset } from '../apps/server/src/branding/assets.mjs';
import { themeCss } from '../apps/server/src/branding/theme.mjs';
import { forgetRealms } from '../apps/server/src/realms/realm.mjs';
const svg = body => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);
test('contrast uses WCAG relative luminance; the defaults meet AA in light and dark', () => {
    assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
    assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48');
    assertContrast(resolveBranding());
});
test('branding refuses unknown fields, bad colours, fonts, links, copy and low contrast', () => {
    for (const bad of [{ css: 'body{}' }, { theme: { primary: 'red' } }, { theme: { font: 'Comic Sans' } }, { theme: { radius: 99 } }, { privacy_url: 'http://x.test' },
        { privacy_url: 'javascript:alert(1)' }, { copy: { sign_in_heading: '<b>‮</b>' } }, { copy: { unknown: 'x' } }, { logo_light: '../etc' }, { theme_dark: { font: 'serif' } }])
        assert.throws(() => validateBranding(bad), error => error.code === 'branding', JSON.stringify(bad));
    assert.throws(() => assertContrast(resolveBranding({ theme: { text: '#999999' } })), error => error.code === 'branding_contrast');
    assert.throws(() => assertContrast(resolveBranding({ theme: { primary: '#ffeb3b', primary_text: '#ffffff' } })), error => error.code === 'branding_contrast');
    assert.ok(validateBranding({ name: 'Acme', theme: { primary: '#0b5d1e', font: 'serif', radius: 4 }, copy: { sign_in_heading: 'Welcome back' }, privacy_url: 'https://acme.test/privacy' }));
});
test('the theme stylesheet sets variables only, for light and dark', () => {
    const css = themeCss(resolveBranding({ theme: { primary: '#0b5d1e', font: 'serif' }, theme_dark: { primary: '#7fd18f' } }));
    assert.match(css, /--primary:#0b5d1e/); assert.match(css, /prefers-color-scheme:dark\)\{:root\{--primary:#7fd18f/);
    assert.match(css, /--font:Charter/);
    assert.ok(!/url\(|@import|expression/i.test(css));
});
test('assets: magic bytes must match, SVGs with script, handlers, styles, links or entities are refused, size is capped', () => {
    assert.doesNotThrow(() => checkAsset('image/svg+xml', svg('<path d="M0 0h10v10z" fill="#123456"/>')));
    for (const body of ['<script>alert(1)</script>', '<path onload="alert(1)"/>', '<foreignObject></foreignObject>', '<a href="https://x"><path/></a>',
        '<image href="https://evil.example/x.png"/>', '<style>@import url(x)</style>', '<path fill="url(https://x)"/>', '<use href="data:image/svg+xml,..."/>'])
        assert.throws(() => checkAsset('image/svg+xml', svg(body)), error => error.code === 'invalid_request', body);
    assert.throws(() => checkAsset('image/svg+xml', new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')));
    assert.throws(() => checkAsset('image/png', new TextEncoder().encode('<svg/>')), error => error.code === 'invalid_request');
    assert.throws(() => checkAsset('image/png', new Uint8Array(300000)), error => error.code === 'invalid_request');
    assert.throws(() => checkAsset('text/html', new Uint8Array([1])), error => error.code === 'invalid_request');
});
test('admins upload a logo and set realm branding; pages show it with a sandboxed asset, theme link and footer', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const upload = await admin.post('branding/assets', { content_type: 'image/svg+xml', data: Buffer.from(svg('<path d="M0 0h10v10z"/>')).toString('base64') });
    assert.equal(upload.status, 200, await upload.clone().text());
    const { id, url } = await upload.json();
    const asset = await w.call(url);
    assert.equal(asset.headers.get('content-type'), 'image/svg+xml');
    assert.match(asset.headers.get('content-security-policy'), /sandbox/);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    const { version } = await (await admin.get('branding')).json();
    assert.equal((await admin.post('branding', { version, branding: { theme: { text: '#cccccc' } } })).status, 400, 'contrast checked on save');
    assert.equal((await admin.post('branding', { version, branding: { logo_light: 'a'.repeat(64) } })).status, 400, 'unknown asset');
    const saved = await admin.post('branding', { version, branding: { logo_light: id, legal_name: 'Vibernt Ltd', privacy_url: 'https://vibernt.example/privacy', terms_url: 'https://vibernt.example/terms',
        support_email: 'help@vibernt.example', theme: { primary: '#0b5d1e' }, copy: { signed_out: 'See you soon.', footer: 'Built on Imprim' } } });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await admin.post('branding', { version, branding: {} })).status, 409, 'stale version');
    const page = await (await w.call('/signed-out')).text();
    assert.match(page, new RegExp(`<img src="/assets/brand/${id}" alt="Vibernt">`));
    assert.match(page, /<link rel="stylesheet" href="\/assets\/theme.css">/);
    assert.match(page, /<a href="https:\/\/vibernt.example\/privacy">Privacy<\/a> · <a href="https:\/\/vibernt.example\/terms">Terms<\/a>/);
    assert.match(page, /See you soon\./); assert.match(page, /© Vibernt Ltd/);
    assert.match(await (await w.call('/assets/theme.css')).text(), /--primary:#0b5d1e/);
    assert.equal((await w.call('/assets/brand/' + 'f'.repeat(64))).status, 404);
});
test('an app overrides the realm: name, copy and theme on its sign-in page and in its sign-in email', async t => {
    const w = await world(t);
    w.env.DB.db.prepare("UPDATE realms SET config=json_set(config,'$.branding',json(?)) WHERE id='default'").run(JSON.stringify({ support_email: 'help@vibernt.example', legal_name: 'Vibernt Ltd' }));
    w.env.DB.db.prepare("UPDATE clients SET branding=? WHERE id='app'").run(JSON.stringify({ name: 'Assay', theme: { primary: '#5b21b6' }, copy: { sign_in_heading: 'Welcome to Assay', sign_in_help: 'Use your work email.' } }));
    forgetRealms(w.env);
    const html = await (await w.authorize()).text();
    assert.match(html, /<h1>Welcome to Assay<\/h1><p>Use your work email\.<\/p>/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/theme.css\?client=app">/);
    assert.match(html, /<header class="brand"><span>Assay<\/span><\/header>/);
    assert.match(await (await w.call('/assets/theme.css?client=app')).text(), /--primary:#5b21b6/);
    assert.match(await (await w.call('/assets/theme.css?client=other')).text(), /--primary:#2346d8/);
    turnstile(t);
    const flow = await begin(w);
    await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email: 'person@example.com', turnstile: crypto.randomUUID() }, flow.cookie);
    await w.drain();
    assert.equal(w.mails.at(-1).subject, 'Sign in to Assay');
    assert.match(w.mails.at(-1).text, /Help: help@vibernt\.example\n© Vibernt Ltd$/);
});
test('app branding is validated when saved, against the realm, including contrast', async t => {
    const w = await world(t); turnstile(t);
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    const admin = await adminLogin(w);
    const current = await (await admin.get('clients/app')).json();
    assert.equal((await admin.post('clients/app', { version: current.version, branding: { name: 'X', theme: { primary: '#fafafa' } } })).status, 400);
    assert.equal((await admin.post('clients/app', { version: current.version, branding: { name: 'X', script: 'alert(1)' } })).status, 400);
    const ok = await admin.post('clients/app', { version: current.version, branding: { name: 'X', theme: { primary: '#14532d' } } });
    assert.equal(ok.status, 200, await ok.clone().text());
});
test('branded text is escaped everywhere', async t => {
    const w = await world(t);
    w.env.DB.db.prepare("UPDATE clients SET branding=? WHERE id='app'").run(JSON.stringify({ name: '<img src=x onerror=alert(1)>', copy: { sign_in_help: '"><script>alert(1)</script>' } }));
    const html = await (await w.authorize()).text();
    assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert'));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
test('the admin preview renders an app\'s sign-in page', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    w.env.DB.db.prepare("UPDATE clients SET branding=? WHERE id='app'").run(JSON.stringify({ name: 'Preview App' }));
    const html = await (await w.call('/admin/branding/preview?client=app', { headers: { cookie: admin.cookie } })).text();
    assert.match(html, /Sign in to Preview App/);
});
