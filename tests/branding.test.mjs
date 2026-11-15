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
    assert.match(html, /<html lang="en">/);
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
    w.env.DB.db.prepare("UPDATE clients SET branding=? WHERE id='app'").run(JSON.stringify({ name: 'Preview App', locale: 'en-GB' }));
    const html = await (await w.call('/admin/branding/preview?client=app', { headers: { cookie: admin.cookie } })).text();
    assert.match(html, /Sign in to Preview App/);
    assert.match(html, /<html lang="en-GB">/);
});
// Review regressions (2026-11-15).
const NS = 'xmlns="http://www.w3.org/2000/svg"', enc = s => new TextEncoder().encode(s);
test('SVG allowlist: prefixed names, processing instructions, escapes, filters, animation and foreign encodings are refused', () => {
    const refused = [
        `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`,
        `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:a href="javascript&#58;alert(1)"><path d="M0 0h9v9z"/></s:a></svg>`,
        `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:use href="//evil.example/x.svg#a"/></svg>`,
        `<?xml-stylesheet type="text/xsl" href="//evil.example/x.xsl"?><svg ${NS}/>`,
        `<svg ${NS}><path style="fill:\\75rl(//evil.example/x)" d="M0 0"/></svg>`,
        `<svg ${NS}><filter id="f"><feImage href="//evil.example/x.png"/></filter></svg>`,
        `<svg ${NS}><animateMotion dur="1s"/></svg>`,
        `<?xml version="1.0" encoding="ISO-2022-JP"?><svg ${NS}><scr\x1b(Bipt>alert(1)</scr\x1b(Bipt></svg>`,
        `<svg ${NS}><path fill="url(//evil.example/x)" d="M0 0"/></svg>`,
        `<svg ${NS}><![CDATA[<script>alert(1)</script>]]></svg>`,
        `<svg ${NS}><title>&x;</title></svg>`,
        `<svg ${NS} onload="alert(1)"/>`,
        `<svg xmlns="http://evil.example/ns"/>`,
        `<path ${NS} d="M0 0"/>`,
        `<svg ${NS}><path d="M0 0" <script>/></svg>`
    ];
    for (const body of refused) assert.throws(() => checkAsset('image/svg+xml', enc(body)), error => error.code === 'invalid_request', body);
    assert.doesNotThrow(() => checkAsset('image/svg+xml', enc(`<?xml version="1.0" encoding="UTF-8"?><!-- Logo --><svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" role="img" aria-label="Acme">
<title>Acme &amp; Co</title><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#123456"/><stop offset="1" stop-color="#abcdef"/></linearGradient></defs>
<g transform="translate(1 1) scale(0.8)"><path d="M0 0h10v10z" fill="url(#g)" fill-rule="evenodd"/><circle cx="5" cy="5" r="2" stroke="#000" stroke-width="0.5"/></g></svg>`)));
    assert.throws(() => checkAsset('image/webp', enc('RIFF\0\0\0\0WAVEfmt ')), error => error.code === 'invalid_request');
    assert.doesNotThrow(() => checkAsset('image/webp', enc('RIFF\0\0\0\0WEBPVP8 ')));
});
test('a 200 KB logo uploads through HTTP and comes back byte for byte (D1 returns BLOBs as arrays); larger bodies and loose base64 are refused', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const png = new Uint8Array(65536 * 3); for (let i = 0; i < 3; i++) crypto.getRandomValues(png.subarray(i * 65536, (i + 1) * 65536)); png.set([0x89, 0x50, 0x4e, 0x47]);
    const upload = await admin.post('branding/assets', { content_type: 'image/png', data: Buffer.from(png).toString('base64') });
    assert.equal(upload.status, 200, await upload.clone().text());
    const served = await w.call((await upload.json()).url);
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_asset_upload'").get().n, 1, 'stored and audited together');
    const big = new Uint8Array(270000); big.set([0x89, 0x50, 0x4e, 0x47]);
    assert.ok([400, 413].includes((await admin.post('branding/assets', { content_type: 'image/png', data: Buffer.from(big).toString('base64') })).status));
    const b64 = Buffer.from(`<svg ${NS}><path d="M0 0h1v1z"/></svg>`).toString('base64');
    assert.equal((await admin.post('branding/assets', { content_type: 'image/svg+xml', data: b64.slice(0, 8) + ' \n ' + b64.slice(8) })).status, 400);
    assert.equal((await admin.post('branding/assets', { content_type: 'image/svg+xml', data: b64, extra: 1 })).status, 400);
});
test('a realm change that would leave an app failing contrast is refused, naming the app', async t => {
    const w = await world(t); turnstile(t);
    w.env.DB.db.exec("UPDATE clients SET backchannel_uri='https://app.example/backchannel' WHERE id='app'");
    const admin = await adminLogin(w);
    const current = await (await admin.get('clients/app')).json();
    assert.equal((await admin.post('clients/app', { version: current.version, branding: { name: 'X', theme: { primary: '#14532d' } } })).status, 200);
    const { version } = await (await admin.get('branding')).json();
    const dark = { background: '#000000', surface: '#000000', text: '#ffffff', muted: '#bbbbbb', primary: '#8aa8ff', primary_text: '#000000', border: '#333333', danger: '#ff8f87' };
    const refused = await admin.post('branding', { version, branding: { theme: dark } });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error_description, /\bapp\b/);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_branding_update'").get().n, 0);
});
test('contrast covers the footer (muted on background) and warnings (danger on surface); type confusion is refused', () => {
    assert.throws(() => assertContrast(resolveBranding({ theme: { background: '#9aa0a6' } })), error => error.code === 'branding_contrast');
    assert.throws(() => assertContrast(resolveBranding({ theme_dark: { danger: '#9b1c1c' } })), error => error.code === 'branding_contrast');
    assert.match(themeCss(resolveBranding()), /--danger:#b42318/);
    for (const bad of [{ locale: ['en'] }, { theme: { font: ['serif'] } }, { name: 'Acme‮' }, { name: 'Acme\u0085' }])
        assert.throws(() => validateBranding(bad), error => error.code === 'branding', JSON.stringify(bad));
});
test('an app\'s empty name falls back to the realm\'s branding name', async t => {
    const w = await world(t);
    w.env.DB.db.prepare("UPDATE realms SET config=json_set(config,'$.branding',json(?)) WHERE id='default'").run(JSON.stringify({ name: 'Brand Name' }));
    w.env.DB.db.prepare("UPDATE clients SET branding=? WHERE id='app'").run(JSON.stringify({ name: '' }));
    forgetRealms(w.env);
    assert.match(await (await w.authorize()).text(), /Sign in to Brand Name/);
});
test('branding is realm-scoped: assets, app themes and previews of another realm are not reachable', async t => {
    const w = await world(t); turnstile(t);
    const { default: worker } = await import('../apps/server/src/worker.mjs');
    const { sha256 } = await import('../apps/server/src/lib/crypto.mjs');
    const ACME = 'https://id.acme.test';
    w.env.DB.db.prepare(`INSERT INTO realms(id,issuer,display_name,config,created) VALUES('acme',?,'Acme','{}',0)`).run(ACME);
    w.env.DB.db.prepare(`INSERT INTO clients(id,secret_hash,redirect_uris,signup_policy,sign_in_methods,realm_id,branding) VALUES('acme-app',?,?,'open','["email"]','acme',?)`)
        .run(await sha256('secret'), JSON.stringify(['https://acme-app.test/callback']), JSON.stringify({ name: 'AcmeApp', theme: { primary: '#5b21b6' } }));
    forgetRealms(w.env);
    const acme = path => worker.fetch(new Request(ACME + path), w.env, { waitUntil() {} });
    const admin = await adminLogin(w);
    const up = await (await admin.post('branding/assets', { content_type: 'image/svg+xml', data: Buffer.from(`<svg ${NS}><path d="M0 0h1v1z"/></svg>`).toString('base64') })).json();
    assert.equal((await w.call(up.url)).status, 200);
    assert.equal((await acme(up.url)).status, 404);
    assert.doesNotMatch(await (await w.call('/assets/theme.css?client=acme-app')).text(), /#5b21b6/);
    assert.match(await (await acme('/assets/theme.css?client=acme-app')).text(), /#5b21b6/);
    assert.doesNotMatch(await (await w.call('/admin/branding/preview?client=acme-app', { headers: { cookie: admin.cookie } })).text(), /AcmeApp/);
});
test('branding writes need the CSRF token and the issuer Origin', async t => {
    const w = await world(t); turnstile(t);
    const admin = await adminLogin(w);
    const { version } = await (await admin.get('branding')).json();
    assert.equal((await admin.post('branding', { version, branding: {} }, { 'x-csrf-token': 'nope' })).status, 403);
    assert.ok((await admin.post('branding/assets', { content_type: 'image/png', data: 'iVBORw==' }, { origin: 'https://evil.example' })).status >= 400);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event IN ('admin_branding_update','admin_asset_upload')").get().n, 0);
});
test('agent consent uses the merged realm and app branding', async t => {
    const { agentWorld } = await import('./support/agents.mjs');
    const w = await agentWorld(t);
    w.env.DB.db.prepare("UPDATE realms SET config=json_set(config,'$.branding',json(?)) WHERE id='default'").run(JSON.stringify({ copy: { consent_intro: 'Agents act as you, within the scopes below.' } }));
    forgetRealms(w.env);
    const flow = await w.start();
    const html = await (await w.call('/agent/consent?request_id=' + flow.id, { headers: { cookie: flow.cookie } })).text();
    assert.match(html, /Agents act as you, within the scopes below\./);
    assert.match(html, /App: Example App/);
    assert.match(html, /theme\.css\?client=app/);
});
