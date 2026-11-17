import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { composeEmail } from '../apps/server/src/services/email/send.mjs';
import { EMAILS } from '../apps/server/src/services/email/messages.mjs';
import { catalogues, LANGUAGES } from '../apps/server/src/i18n/index.mjs';
const ISSUER = 'https://id.example.com';
const TIME = Date.UTC(2026, 10, 17, 9, 30);
const footer = '\n\n--\nAcme accounts run on Imprim.\nHelp: help@acme.example\n© Acme Ltd';
const branding = { name: 'Acme', legal_name: 'Acme Ltd', support_email: 'help@acme.example', copy: { footer: 'Acme accounts run on Imprim.' } };
const realm = { name: 'Vibernt', copy: { footer: 'Acme accounts run on Imprim.' }, legal_name: 'Acme Ltd', support_email: 'help@acme.example' };
const security = `\n\nIf this was not you, sign in with an email link at ${ISSUER}/login, then review your account at ${ISSUER}/account.`;
// Every kind's English text and subject, exactly as Imprim sent them before HTML email and translations.
const ENGLISH = {
    sign_in_link: [{ links: { link: `${ISSUER}/login#token=abc` }, branding }, 'Sign in to Acme',
        `Open this link in the browser where you started, then choose Sign in. It expires in 15 minutes.\n\n${ISSUER}/login#token=abc\n\nIgnore this email if you did not request it.${footer}`],
    password_link: [{ links: { link: `${ISSUER}/login#token=abc` }, branding }, 'Set your password for Acme',
        `Open this link in the browser where you started, then choose Continue, then set your password. It expires in 15 minutes.\n\n${ISSUER}/login#token=abc\n\nIgnore this email if you did not request it.${footer}`],
    email_change_link: [{ links: { link: `${ISSUER}/account/email/confirm?token=abc` } }, 'Vibernt: confirm your new email',
        `Open this link in the browser where you asked for the change, then choose Confirm. It expires in 15 minutes.\n\n${ISSUER}/account/email/confirm?token=abc\n\nIgnore this email if you did not ask for it.`],
    new_sign_in: [{ vars: { device: 'Chrome on macOS', time: TIME } }, 'Vibernt: new sign-in', `Your account was signed in from Chrome on macOS on ${new Date(TIME).toUTCString()}.${security}${footer}`],
    new_sign_in_at: [{ vars: { device: 'Firefox', place: 'Berlin, DE', time: TIME } }, 'Vibernt: new sign-in', `Your account was signed in from Firefox in Berlin, DE on ${new Date(TIME).toUTCString()}.${security}${footer}`],
    password_changed: [{ vars: { time: TIME } }, 'Vibernt: your password was changed', `Your password was changed on ${new Date(TIME).toUTCString()}. Other signed-in sessions were signed out.${security}${footer}`],
    password_set: [{ vars: { time: TIME } }, 'Vibernt: a password was set on your account', `A password was set for your account on ${new Date(TIME).toUTCString()}. Other signed-in sessions were signed out.${security}${footer}`],
    mfa_reset: [{ vars: { reason: 'Lost phone' } }, 'Vibernt: your two-factor authentication was reset', `An administrator reset two-factor authentication on your account (reason: Lost phone). You were signed out and will set it up again at your next sign-in.${security}${footer}`],
    recovery_code_used: [{}, 'Vibernt: a recovery code was used', `A recovery code was used to sign in. You have one fewer left; generate a new set at /account/mfa if you are running low.${security}${footer}`],
    agent_connected: [{ vars: { agent: 'Claude Code', app: 'Notes', workspace: 'team-one', scopes: 'read write' }, links: { agents_url: `${ISSUER}/account/agents` } }, 'Vibernt: an agent was connected',
        `"Claude Code" can now act for you in Notes (team-one) with: read write. Review or revoke it at ${ISSUER}/account/agents.${security}${footer}`],
    passkey_added: [{ vars: { name: 'Work laptop' } }, 'Vibernt: a passkey was added', `A passkey ("Work laptop") was added to your account.${security}${footer}`],
    passkey_removed: [{ vars: { name: 'Work laptop' } }, 'Vibernt: a passkey was removed', `The passkey "Work laptop" was removed from your account.${security}${footer}`],
    factor_added: [{ vars: { name: 'Phone' } }, 'Vibernt: a second factor was added', `An authenticator app ("Phone") was added to your account. Remembered browsers were signed out of their second-factor exemption.${security}${footer}`],
    factor_removed: [{ vars: { name: 'Phone' } }, 'Vibernt: a second factor was removed', `The authenticator "Phone" was removed from your account.${security}${footer}`],
    recovery_codes_regenerated: [{}, 'Vibernt: new recovery codes were generated', `Your recovery codes were replaced. The old ones no longer work.${security}${footer}`],
    email_change_requested: [{ vars: { email: 'new@example.com' } }, 'Vibernt: email change requested', `Someone signed in to your account asked to change its email to new@example.com. Nothing changes until that address is confirmed.${security}${footer}`],
    email_changed: [{ vars: { old: 'old@example.com', new: 'new@example.com' } }, 'Vibernt: your email was changed', `Your account's email changed from old@example.com to new@example.com. If you did not do this, contact the app you use.${security}${footer}`],
    account_deleted: [{}, 'Vibernt: your account was deleted', `Your account was deleted and you were signed out everywhere.${security}${footer}`]
};
async function setup(t) {
    const w = await world(t);
    w.env.REALM.branding = realm;
    return w;
}
test('every kind of email has an exact English text part, unchanged, and an HTML part', async t => {
    const w = await setup(t);
    assert.deepEqual(Object.keys(ENGLISH).sort(), Object.keys(EMAILS).sort(), 'every kind is covered');
    for (const [kind, [options, subject, text]] of Object.entries(ENGLISH)) {
        const mail = await composeEmail(w.env, { kind, to: 'p@example.com', locale: 'en', ...options });
        assert.equal(mail.subject, subject, kind);
        assert.equal(mail.text, text, kind);
        assert.equal(mail.from, 'signin@example.com');
        assert.match(mail.html, /^<!doctype html><html lang="en" dir="ltr">/, kind);
        assert.ok(mail.html.includes('<meta name="color-scheme" content="light dark">'), kind);
        assert.ok(mail.html.includes('@media (prefers-color-scheme: dark)'), kind);
        assert.equal(mail.attachments, undefined, 'no logo, no attachment');
    }
});
test('every kind exists in every shipped language, and the text keeps its links', async t => {
    const w = await setup(t);
    for (const locale of LANGUAGES) for (const [kind, [options]] of Object.entries(ENGLISH)) {
        const mail = await composeEmail(w.env, { kind, to: 'p@example.com', locale, ...options });
        for (const url of Object.values(options.links || {})) assert.ok(mail.text.includes(url) && mail.html.includes(url.replace(/&/g, '&amp;')), `${locale} ${kind}`);
        assert.match(mail.html, new RegExp(`<html lang="${locale}"`));
        if (locale !== 'en') assert.notEqual(mail.subject, ENGLISH[kind][1], `${locale} ${kind} is translated`);
    }
    const german = await composeEmail(w.env, { kind: 'password_changed', to: 'p@example.com', locale: 'de', vars: { time: TIME } });
    assert.ok(german.text.includes('UTC') && !german.text.includes('GMT'), 'dates are written in the language');
});
test('the HTML part escapes every value: agent names, brand names, reasons and devices cannot add markup', async t => {
    const w = await setup(t);
    const evil = '<img src=x onerror=alert(1)>"\'&', named = { ...branding, name: evil, legal_name: evil, copy: { footer: evil } };
    for (const locale of ['en', 'de']) {
        const mails = [
            await composeEmail(w.env, { kind: 'agent_connected', to: 'p@example.com', locale, vars: { agent: evil, app: evil, workspace: evil, scopes: evil }, links: { agents_url: `${ISSUER}/account/agents` } }),
            await composeEmail(w.env, { kind: 'sign_in_link', to: 'p@example.com', locale, branding: named, links: { link: `${ISSUER}/login#token=a` } }),
            await composeEmail(w.env, { kind: 'mfa_reset', to: 'p@example.com', locale, vars: { reason: evil } }),
            await composeEmail(w.env, { kind: 'new_sign_in_at', to: 'p@example.com', locale, vars: { device: evil, place: evil, time: TIME } })];
        for (const mail of mails) {
            assert.ok(!mail.html.includes('<img src=x'), 'no raw markup from input');
            assert.ok(mail.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
            // Links are the issuer's own, or none.
            for (const [, href] of mail.html.matchAll(/href="([^"]*)"/g)) assert.ok(href.startsWith(ISSUER + '/'), href);
            assert.ok(!/<(script|iframe|form|object|link)/i.test(mail.html));
            assert.ok(!/src="(?!cid:)/.test(mail.html), 'no remote images');
        }
    }
});
test('brand links in the footer are the validated https ones; subjects are one line', async t => {
    const w = await setup(t);
    const mail = await composeEmail(w.env, { kind: 'sign_in_link', to: 'p@example.com', branding: { ...branding, privacy_url: 'https://acme.example/privacy', terms_url: 'https://acme.example/terms' }, links: { link: `${ISSUER}/login#token=a` } });
    assert.ok(mail.html.includes('href="https://acme.example/privacy"') && mail.html.includes('href="https://acme.example/terms"'));
    w.env.REALM.display_name = 'Evil\r\nBcc: victim@example.com\u2028x';
    const notice = await composeEmail(w.env, { kind: 'account_deleted', to: 'p@example.com' });
    assert.ok(!/[\r\n\u2028]/.test(notice.subject), JSON.stringify(notice.subject));
});
test('a PNG or JPEG logo travels inline; an SVG logo, or none, draws the initial in dots', async t => {
    const w = await setup(t);
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const store = (id, type, data) => w.env.DB.db.prepare('INSERT INTO brand_assets(id,realm_id,content_type,data,created) VALUES(?,?,?,?,0)').run(id, 'default', type, data);
    store('a'.repeat(64), 'image/png', png); store('b'.repeat(64), 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')); store('c'.repeat(64), 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]));
    store('d'.repeat(64), 'image/png', png);
    const withLogo = await composeEmail(w.env, { kind: 'sign_in_link', to: 'p@example.com', branding: { ...branding, logo_light: 'a'.repeat(64), logo_dark: 'c'.repeat(64) }, links: { link: `${ISSUER}/login#token=a` } });
    assert.deepEqual(withLogo.attachments.map(a => [a.contentId, a.type, a.disposition]), [['logo-light', 'image/png', 'inline'], ['logo-dark', 'image/jpeg', 'inline']]);
    assert.equal(withLogo.attachments[0].content, btoa(String.fromCharCode(...png)));
    assert.ok(withLogo.html.includes('src="cid:logo-light"') && withLogo.html.includes('src="cid:logo-dark"') && withLogo.html.includes('.im-logo-dark{display:block!important}'));
    const svg = await composeEmail(w.env, { kind: 'sign_in_link', to: 'p@example.com', branding: { ...branding, logo_light: 'b'.repeat(64) }, links: { link: `${ISSUER}/login#token=a` } });
    assert.equal(svg.attachments, undefined);
    assert.ok(svg.html.includes('class="im-dot"') && !svg.html.includes('cid:'));
    // Another realm's asset id is not this realm's logo.
    w.env.DB.db.prepare("INSERT INTO realms(id,display_name,config,status,created) VALUES('other','Other','{}','active',0)").run();
    w.env.DB.db.prepare("UPDATE brand_assets SET realm_id='other' WHERE id=?").run('d'.repeat(64));
    const foreign = await composeEmail(w.env, { kind: 'sign_in_link', to: 'p@example.com', branding: { ...branding, logo_light: 'd'.repeat(64) }, links: { link: `${ISSUER}/login#token=a` } });
    assert.equal(foreign.attachments, undefined);
});
test('the look sets the colours and font; a forced theme has no dark-mode switch', async t => {
    const w = await setup(t);
    const forest = await composeEmail(w.env, { kind: 'account_deleted', to: 'p@example.com', branding: { look: { palette: 'forest', type: 'editorial', corners: 0.5 } } });
    assert.ok(forest.html.includes('#1f9d55'), 'the palette accent');
    assert.ok(forest.html.includes("'Fraunces'") && forest.html.includes("'Instrument Sans'"));
    assert.ok(forest.html.includes('border-radius:6px'));
    const light = await composeEmail(w.env, { kind: 'account_deleted', to: 'p@example.com', branding: { look: { theme: 'light' } } });
    assert.ok(!light.html.includes('prefers-color-scheme') && light.html.includes('content="light"'));
    const dark = await composeEmail(w.env, { kind: 'account_deleted', to: 'p@example.com', branding: { look: { theme: 'dark' } } });
    assert.ok(dark.html.includes('content="dark"'));
});
test('sent mail carries both parts, and a failed send never logs the link', async t => {
    const w = await world(t);
    const { login } = await import('./support/world.mjs');
    await login(w, t);
    const mail = w.mails.at(-1);
    assert.ok(mail.text && mail.html && mail.subject);
    assert.ok(mail.html.includes(mail.text.match(/https:\/\/\S+#token=[\w-]+/)[0]));
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
    w.env.EMAIL.send = async () => { throw Object.assign(new Error('provider failed https://id.example.com/login#token=secret'), { code: 'E_X' }); };
    const { notify } = await import('../apps/server/src/services/notify.mjs');
    const pending = []; notify(w.env, { waitUntil: p => pending.push(p) }, 'p@example.com', 'account_deleted');
    await Promise.all(pending);
    assert.deepEqual(logged, ['{"type":"notice_failed","code":"E_X"}']);
});
test('the German subject and text are German', async t => {
    const w = await setup(t), de = catalogues.get('de');
    const mail = await composeEmail(w.env, { kind: 'sign_in_link', to: 'p@example.com', locale: 'de', branding, links: { link: `${ISSUER}/login#token=a` } });
    assert.equal(mail.subject, de['Sign in to {name}'].replace('{name}', 'Acme'));
    assert.ok(mail.text.startsWith(de['Open this link in the browser where you started, then choose Sign in. It expires in 15 minutes.']));
    assert.ok(mail.html.includes(de['Sign in'].replace(/&/g, '&amp;')));
});
test('a link inside a sentence is linked whole, never as the shorter link it starts with', async t => {
    const w = await setup(t);
    const mail = await composeEmail(w.env, { kind: 'agent_connected', to: 'p@example.com', vars: { agent: 'A', app: 'B', workspace: 'c', scopes: 'read' }, links: { agents_url: `${ISSUER}/account/agents` } });
    assert.ok(mail.html.includes(`href="${ISSUER}/account/agents" `), 'the agents link');
    assert.ok(!mail.html.includes(`${ISSUER}/account</a>/agents`));
});
