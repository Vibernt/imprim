// Translations for people-facing pages, the errors they show, and emails. The English text in code is the message id;
// each other language is a frozen module that maps ids to translations (docs/TRANSLATING.md). A message with no
// translation is shown in English, so a missing entry never stops a page. `npm run check` lists them.
//
// Each request settles one locale (env.I18N), from the first of these that the brand offers: the app's `ui_locales`,
// the person's saved language, Accept-Language, the app's and then the realm's `branding.locale`, then English.
import { LANGUAGES, canonicalTag, languageOf, fill } from './languages.mjs';
import { resolveBranding } from '../branding/tokens.mjs';
import es from './es.mjs';
import fr from './fr.mjs';
import de from './de.mjs';
import ptBR from './pt-BR.mjs';
export { LANGUAGES, LANGUAGE_NAMES, canonicalTag, languageOf, fill } from './languages.mjs';
// The catalogues by tag. English has none: its text is the id.
export const catalogues = new Map([['en', Object.freeze({})], ['es', es], ['fr', fr], ['de', de], ['pt-BR', ptBR]]);
// The translation of one id in one locale, before placeholders are filled. A plural entry is an object of forms.
function lookup(locale, id) {
    const catalogue = catalogues.get(locale);
    return catalogue && Object.hasOwn(catalogue, id) ? catalogue[id] : undefined;
}
export const localeOf = env => env?.I18N?.locale || 'en';
// Plain text: the caller escapes it, as the page helpers in pages/ui.mjs already do.
export function translate(locale, id, vars) {
    const found = lookup(locale, id);
    return fill(typeof found === 'string' ? found : id, vars);
}
export const t = (env, id, vars) => translate(localeOf(env), id, vars);
// One of a message's plural forms, chosen by Intl.PluralRules for the locale. `one` and `other` are the English forms;
// `other` is the id. `{count}` is filled with the number.
export function tPlural(env, count, one, other, vars = {}) {
    const locale = localeOf(env), found = lookup(locale, other);
    const [forms, rules] = found && typeof found === 'object' ? [found, locale] : typeof found === 'string' ? [{ other: found }, locale] : [{ one, other }, 'en'];
    return fill(forms[new Intl.PluralRules(rules).select(count)] ?? forms.other, { count, ...vars });
}
// Text that holds markup: the translation is escaped for a text node, then `{name}` values are inserted escaped (or, for
// a value given as `{ html }`, as that already-safe markup) and each numbered tag `<0>…</0>` is replaced by
// `tags[0](innerEscapedText)`. A translation can move tags but never add markup of its own.
const escapeText = value => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
export function tHtml(env, id, vars = {}, tags = []) {
    const found = lookup(localeOf(env), id), text = escapeText(typeof found === 'string' ? found : id);
    const escapedVars = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, value && typeof value === 'object' ? value.html : escapeText(value)]));
    return fill(text, escapedVars).replace(/&lt;(\d)&gt;([\s\S]*?)&lt;\/\1&gt;/g, (whole, n, inner) => tags[n] ? tags[n](inner) : inner);
}
// An error's message in the request's locale. Errors keep their English id and values (lib/errors.mjs).
export const tError = (env, error) => translate(localeOf(env), error.msgid ?? error.message, error.vars);

// --- Choosing the locale -------------------------------------------------------------------------------------------
// Accept-Language is untrusted: only its first 1 KiB and 20 entries are read; `*`, q=0 and malformed entries are
// dropped. Tags come back in preference order, each once.
export function parseAcceptLanguage(header) {
    if (typeof header !== 'string') return [];
    const entries = header.slice(0, 1024).split(',').slice(0, 20).map((part, index) => {
        const [tag, ...params] = part.trim().split(';').map(piece => piece.trim());
        const q = params.find(param => /^q=/i.test(param));
        const weight = q === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.test(q) ? Number(q.slice(2)) : 0;
        return { tag: canonicalTag(tag), weight, index };
    }).filter(entry => entry.tag && entry.weight > 0);
    entries.sort((a, b) => b.weight - a.weight || a.index - b.index);
    return [...new Set(entries.map(entry => entry.tag))];
}
// OIDC `ui_locales`: space-separated tags, in preference order. Malformed or unknown tags are dropped silently, as
// OIDC Core 3.1.2.1 says; at most ten are kept. Returns the stored form (or null for none).
export function parseUiLocales(value) {
    if (typeof value !== 'string' || value.length > 512) return null;
    const tags = [...new Set(value.split(' ').map(canonicalTag).filter(Boolean))].slice(0, 10);
    return tags.length ? tags.join(' ') : null;
}
// The shipped language that serves a tag: the same tag, or the same language (de-AT → de, pt-PT → pt-BR).
export function matchLanguage(tag, offered) {
    const canonical = canonicalTag(tag);
    if (!canonical) return null;
    if (offered.includes(canonical)) return canonical;
    const language = languageOf(canonical);
    return offered.find(item => item === language) ?? offered.find(item => languageOf(item) === language) ?? null;
}
// The languages a brand offers: its `locales`, limited to the shipped ones, else every shipped language (and any
// catalogue a test registers).
export const offeredBy = branding => {
    const available = [...catalogues.keys()];
    const chosen = Array.isArray(branding?.locales) ? branding.locales.filter(tag => available.includes(tag)) : [];
    return chosen.length ? chosen : available;
};
export function negotiate({ ui = [], user = null, accept = [], appLocale = null, realmLocale = null, offered = LANGUAGES }) {
    for (const candidate of [...ui, user, ...accept, appLocale, realmLocale]) {
        const match = candidate && matchLanguage(candidate, offered);
        if (match) return match;
    }
    return offered.includes('en') ? 'en' : offered[0];
}
// <html lang>: the brand's own tag when it is the same language (a realm on en-GB stays en-GB), else the locale.
export const htmlLang = (locale, brandLocale) => brandLocale && canonicalTag(brandLocale) && languageOf(brandLocale) === languageOf(locale) ? brandLocale : locale;
// Per request: the host's realm is known first; the app, the authorization request's ui_locales and the signed-in
// person arrive as handlers load them (useLocale). The admin console stays English.
export function startLocale(env, request, url) {
    env.I18N = { accept: parseAcceptLanguage(request.headers.get('accept-language')), ui: [], user: null, client: null, fixed: /^\/admin(\/|$)/.test(url.pathname) ? 'en' : null };
    settle(env);
}
export function useLocale(env, { client, uiLocales, user } = {}) {
    if (!env?.I18N) return;
    if (client !== undefined) env.I18N.client = client;
    if (uiLocales !== undefined) env.I18N.ui = parseUiLocales(uiLocales)?.split(' ') ?? [];
    if (user !== undefined) env.I18N.user = user;
    settle(env);
}
function settle(env) {
    const state = env.I18N, realm = env.REALM?.branding || {};
    const app = state.client ? JSON.parse(state.client.branding || '{}') : {};
    const branding = resolveBranding(realm, app);
    state.locale = state.fixed || negotiate({ ui: state.ui, user: state.user, accept: state.accept, appLocale: app.locale || null,
        realmLocale: realm.locale || null, offered: offeredBy(branding) });
}
// A locale for work outside the person's own request, such as a notice an administrator's action sends: the
// recipient's saved language, then the realm's.
export function recipientLocale(env, savedLocale) {
    const branding = env.REALM?.branding || {};
    return negotiate({ user: savedLocale, realmLocale: branding.locale || null, offered: offeredBy(branding) });
}
// A brand's own words for one copy key, in the page's language: its translation for this language, then its default
// copy when the page is in the brand's own language, else nothing (the caller shows the built-in text).
export const brandCopy = (env, branding, key) => brandCopyIn(localeOf(env), branding, key);
export function brandCopyIn(locale, branding, key) {
    const own = branding.locale_copy?.[locale]?.[key];
    if (own) return own;
    return languageOf(locale) === languageOf(branding.locale || 'en') ? branding.copy?.[key] : undefined;
}

// --- Dates -------------------------------------------------------------------------------------------------------
// English keeps the formats Imprim has always used; other languages use Intl in UTC.
export const dateTimeIn = (locale, time) => locale === 'en' || !catalogues.has(locale) ? new Date(time).toUTCString()
    : `${new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(time))} UTC`;
export const dateTimeText = (env, time) => dateTimeIn(localeOf(env), time);
const formats = new Map();
export function formatDate(env, time, options) {
    const locale = localeOf(env), key = `${locale}|${JSON.stringify(options)}`;
    if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale, { timeZone: 'UTC', ...options }));
    return formats.get(key).format(new Date(time));
}

// --- Page scripts and constant tables ------------------------------------------------------------------------------
// Marks an English message where no request is at hand (a module-level table, a page script). Translate it later
// with t(); the check script collects every msg() id like any t() id.
export const msg = id => id;
// A page script with its English message literals (single-quoted, each marked with msg()) replaced by their
// translations. English is the script as written. Served as `<path>?lang=<locale>`; other values serve English.
export function localizeScript(source, locale, ids) {
    if (!catalogues.has(locale) || locale === 'en') return source;
    return ids.reduce((script, id) => script.replaceAll(`'${id}'`, () => JSON.stringify(translate(locale, id))), source);
}
export const scriptPath = (env, path) => localeOf(env) === 'en' ? path : `${path}?lang=${encodeURIComponent(localeOf(env))}`;
