import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptLanguage, parseUiLocales, matchLanguage, negotiate, translate, tHtml, tPlural, catalogues, LANGUAGES, localizeScript, htmlLang, brandCopy } from '../apps/server/src/i18n/index.mjs';
import { canonicalTag, fill } from '../apps/server/src/i18n/languages.mjs';
import { extract, checkCatalogue, checkAll } from '../scripts/i18n.mjs';
import { validateBranding, resolveBranding } from '../apps/server/src/branding/tokens.mjs';
import { AppError } from '../apps/server/src/lib/errors.mjs';
const env = locale => ({ I18N: { locale } });

test('Accept-Language: q order, region tags canonical, and junk, q=0 and * dropped', () => {
    assert.deepEqual(parseAcceptLanguage('fr-ch, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5'), ['fr-CH', 'fr', 'en', 'de']);
    assert.deepEqual(parseAcceptLanguage('de;q=0, es;q=0.5, pt-br'), ['pt-BR', 'es']);
    assert.deepEqual(parseAcceptLanguage('"><script>, en_US, 12, x, de;q=2, fr;q=abc, it'), ['it']);
    assert.deepEqual(parseAcceptLanguage(undefined), []);
    assert.deepEqual(parseAcceptLanguage(''), []);
});
test('Accept-Language: an oversized header is cut to 1 KiB and 20 entries, without work proportional to its size', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `x${i % 10}y;q=0.${i % 9}`).join(',') + ',de';
    const started = performance.now(), tags = parseAcceptLanguage('a'.repeat(100000) + ',' + huge);
    assert.ok(performance.now() - started < 50);
    assert.ok(tags.length <= 20);
    assert.ok(!tags.includes('de'), 'entries past the first 20 are never read');
});
test('ui_locales is a preference: malformed, oversized and repeated tags are dropped, never reflected', () => {
    assert.equal(parseUiLocales('de fr-ca'), 'de fr-CA');
    assert.equal(parseUiLocales('"><script>alert(1)</script> de'), 'de');
    assert.equal(parseUiLocales('de\r\nSet-Cookie: x'), null, 'a tag with a line break is not a tag');
    assert.equal(parseUiLocales('ü de'), 'de');
    assert.equal(parseUiLocales('x'.repeat(10000)), null);
    assert.equal(parseUiLocales(Array.from({ length: 50 }, (_, i) => `l${String.fromCharCode(97 + (i % 26))}`).join(' ')).split(' ').length, 10);
    assert.equal(parseUiLocales(['de']), null);
    assert.equal(parseUiLocales(''), null);
    assert.equal(canonicalTag('EN-gb'), 'en-GB');
    assert.equal(canonicalTag('zh-hant-tw'), 'zh-Hant-TW');
    assert.equal(canonicalTag('en-GB-' + 'x'.repeat(40)), null);
});
test('negotiation: ui_locales, then the saved language, then Accept-Language, then the app, then the realm, then English', () => {
    const offered = LANGUAGES;
    assert.equal(negotiate({ ui: ['fr'], user: 'de', accept: ['es'], appLocale: 'pt-BR', realmLocale: 'de', offered }), 'fr');
    assert.equal(negotiate({ ui: ['xx'], user: 'de', accept: ['es'], offered }), 'de');
    assert.equal(negotiate({ accept: ['it', 'es-MX'], appLocale: 'fr', offered }), 'es');
    assert.equal(negotiate({ accept: ['it'], appLocale: 'fr', realmLocale: 'de', offered }), 'fr');
    assert.equal(negotiate({ accept: ['it'], realmLocale: 'de-AT', offered }), 'de');
    assert.equal(negotiate({ accept: ['zz', 'it'], offered }), 'en');
    assert.equal(negotiate({ offered }), 'en');
    assert.equal(matchLanguage('pt-PT', offered), 'pt-BR');
    assert.equal(matchLanguage('de-CH', offered), 'de');
    assert.equal(matchLanguage('not a tag', offered), null);
    // A brand that offers only German uses German whatever the browser asks.
    assert.equal(negotiate({ ui: ['fr'], accept: ['en'], offered: ['de'] }), 'de');
    assert.equal(htmlLang('en', 'en-GB'), 'en-GB');
    assert.equal(htmlLang('de', 'en-GB'), 'de');
    assert.equal(htmlLang('en', 'it'), 'en');
});
test('a missing message or an unknown locale is English; placeholders fill; a missing value stays visible', () => {
    assert.equal(translate('de', 'A message no catalogue has.'), 'A message no catalogue has.');
    assert.equal(translate('xx-YY', 'Sign in to {name}', { name: 'Acme' }), 'Sign in to Acme');
    assert.equal(translate('de', 'Sign in to {name}', { name: 'Acme' }), catalogues.get('de')['Sign in to {name}'].replace('{name}', 'Acme'));
    assert.equal(fill('Hello {name}, {missing}', { name: '{missing}' }), 'Hello {missing}, {missing}', 'a value is inserted once, never re-read as a placeholder');
    assert.equal(translate('de', 'constructor'), 'constructor', 'no prototype property is a translation');
    assert.equal(translate('de', '__proto__'), '__proto__');
});
test('tHtml escapes the translation and the values; only numbered tags become markup', () => {
    catalogues.set('xx', Object.freeze({ 'Click <0>here</0> for {thing}.': '<b>Bold</b> <0>hier</0> {thing} <1>x</1> <script>' }));
    try {
        const html = tHtml(env('xx'), 'Click <0>here</0> for {thing}.', { thing: '<img src=x onerror=alert(1)>' }, [inner => `<a href="/x">${inner}</a>`]);
        assert.equal(html, '&lt;b&gt;Bold&lt;/b&gt; <a href="/x">hier</a> &lt;img src=x onerror=alert(1)&gt; x &lt;script&gt;');
        assert.equal(tHtml(env('xx'), 'Plain {v}', { v: { html: '<code>ok</code>' } }), 'Plain <code>ok</code>');
    } finally { catalogues.delete('xx'); }
});
test('plurals follow each language\'s rules; English keeps its own forms', () => {
    assert.equal(tPlural(env('en'), 1, '{count} unused code', '{count} unused codes'), '1 unused code');
    assert.equal(tPlural(env('en'), 3, '{count} unused code', '{count} unused codes'), '3 unused codes');
    const de = catalogues.get('de')['{count} unused codes'];
    assert.equal(typeof de, 'object');
    assert.equal(tPlural(env('de'), 1, '{count} unused code', '{count} unused codes'), de.one.replace('{count}', '1'));
    assert.equal(tPlural(env('fr'), 0, '{count} unused code', '{count} unused codes'), catalogues.get('fr')['{count} unused codes'].one.replace('{count}', '0'), 'French counts 0 as one');
});
test('errors keep their English id and values, so the boundary can translate them', () => {
    const error = new AppError(400, 'weak_password', 'Use {min} to {max} characters. Long passphrases are best.', { min: 12, max: 128 });
    assert.equal(error.message, 'Use 12 to 128 characters. Long passphrases are best.');
    assert.equal(error.msgid, 'Use {min} to {max} characters. Long passphrases are best.');
});
test('page scripts: English is the file as written; other languages swap only the marked messages; unknown values serve English', () => {
    const source = "say('Request failed.');say('Other text.')";
    assert.equal(localizeScript(source, 'en', ['Request failed.']), source);
    assert.equal(localizeScript(source, 'zz', ['Request failed.']), source);
    assert.equal(localizeScript(source, '"></script>', ['Request failed.']), source);
    assert.equal(localizeScript(source, 'de', ['Request failed.']), `say(${JSON.stringify(catalogues.get('de')['Request failed.'])});say('Other text.')`);
});
test('every shipped language is complete, with matching placeholders, tags and plural forms', async () => {
    const { problems, count, locales } = await checkAll();
    assert.deepEqual(problems, []);
    assert.ok(count > 400);
    assert.deepEqual(locales, LANGUAGES);
    for (const tag of LANGUAGES) assert.ok(Object.isFrozen(catalogues.get(tag)));
});
test('the check refuses missing, orphan, mismatched and markup-adding entries', async () => {
    const extracted = { ids: new Map([['Hello {name}.', 'x'], ['Click <0>here</0>.', 'x'], ['{count} files', 'x'], ['Bye.', 'x']]), plurals: new Set(['{count} files']) };
    const problems = checkCatalogue('de', { 'Hello {name}.': 'Hallo {nom}.', 'Click <0>here</0>.': 'Klick <1>hier</1>.', '{count} files': 'Dateien', 'Orphan': 'x' }, extracted);
    for (const expected of ['must be frozen', 'missing "Bye."', 'orphan "Orphan"', 'placeholders {nom}', 'must keep the tags', 'needs plural forms'])
        assert.ok(problems.some(p => p.includes(expected)), `${expected} in ${problems.join('\n')}`);
    const forms = checkCatalogue('de', Object.freeze({ 'Hello {name}.': '<b>Hallo</b> {name}.', 'Click <0>here</0>.': 'Klick <0>hier</0>.', '{count} files': { one: 'eine Datei', few: 'x' }, 'Bye.': '' }), extracted);
    for (const expected of ['adds markup', 'plural form few', 'lacks the plural form other', 'empty translation']) assert.ok(forms.some(p => p.includes(expected)), expected);
    const { problems: source } = await extract(new URL('./fixtures/i18n-source/', import.meta.url).pathname);
    assert.equal(source.length, 2, source.join('\n'));
});
test('branding: locales, the default language and per-language words are checked, and merge per language', () => {
    assert.deepEqual(validateBranding({ locale: 'de', locales: ['de', 'en'], locale_copy: { de: { sign_in_heading: 'Willkommen' } } }).locales, ['de', 'en']);
    for (const bad of [{ locales: [] }, { locales: ['de', 'de'] }, { locales: ['it'] }, { locales: 'de' }, { locale: 'fr', locales: ['de'] },
        { locale_copy: { it: { footer: 'x' } } }, { locale_copy: { de: { unknown: 'x' } } }, { locale_copy: { de: { footer: 'a\u202eb' } } },
        { locale_copy: { de: { footer: 'x'.repeat(301) } } }, { locale_copy: [] }, { locale_copy: { de: 'x' } }, { locale: '"><x' }])
        assert.throws(() => validateBranding(bad), /branding|copy/, JSON.stringify(bad));
    const merged = resolveBranding({ locale_copy: { de: { footer: 'Realm', signed_out: 'Tschüss' } } }, { locale_copy: { de: { footer: 'App' }, fr: { footer: 'Appli' } } });
    assert.deepEqual(merged.locale_copy, { de: { footer: 'App', signed_out: 'Tschüss' }, fr: { footer: 'Appli' } });
    // The brand's default copy is its default language's; other languages get their own words or the built-in text.
    const branding = { copy: { footer: 'Default' }, locale_copy: { de: { footer: 'Deutsch' } } };
    assert.equal(brandCopy(env('en'), branding, 'footer'), 'Default');
    assert.equal(brandCopy(env('de'), branding, 'footer'), 'Deutsch');
    assert.equal(brandCopy(env('fr'), branding, 'footer'), undefined);
    assert.equal(brandCopy(env('fr'), { ...branding, locale: 'fr' }, 'footer'), 'Default');
});
