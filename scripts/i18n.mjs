// Translation catalogue checks (docs/TRANSLATING.md). English is the source: every message id is English text in
// apps/server/src, written as t(env, '…'), tHtml(env, '…'), tPlural(env, n, '…', '…'), msg('…'), or as the message of an
// error a person can see (invariant(…, 'code', '…') and new AppError(status, 'code', '…') outside the modules below).
//
//   node scripts/i18n.mjs             check every shipped catalogue; exit 1 on any problem
//   node scripts/i18n.mjs missing de  list the ids German lacks, as JSON, for a translator
//   node scripts/i18n.mjs ids         list every id, as JSON
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const SRC = fileURLToPath(new URL('../apps/server/src/', import.meta.url));
// Errors from these modules reach developers, operators or the admin console, never a person's page or script: they
// stay English (protocol error_description is ASCII by RFC 6749; the admin console is English).
export const ENGLISH_ONLY = [/^admin\//, /^machines\//, /^branding\//, /^realms\//, /^i18n\//,
    /^oidc\/(token|keys|jwt|discovery|backchannel|app-sessions|logout-hint)\.mjs$/,
    /^agents\/(token|registration|revocation|grants|client-auth|settings)\.mjs$/,
    /^services\/(invitations|outbox|outbox-destination|outbox-expiry|maintenance|retention|user-events|audit|notify)\.mjs$/,
    /^lib\/(crypto|cbor|qr)\.mjs$/,
    // The workspace API answers apps, not people; only the invitation email (workspaces/email.mjs) is translated.
    /^workspaces\/(?!email\.mjs$)/];
const STRING = String.raw`'((?:\\.|[^'\\])*)'`;
const unquote = text => text.replace(/\\(.)/g, '$1');
async function files(dir, base = '') {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) out.push(...await files(`${dir}${entry.name}/`, `${base}${entry.name}/`));
        else if (entry.name.endsWith('.mjs')) out.push(`${base}${entry.name}`);
    return out;
}
// Every id in the source, with where it was found. `problems` lists ids that are not plain literals.
export async function extract(root = SRC) {
    const ids = new Map(), plurals = new Set(), problems = [];
    const add = (id, where) => { if (!ids.has(id)) ids.set(id, where); };
    for (const path of await files(root)) {
        const source = await readFile(root + path, 'utf8'), people = !ENGLISH_ONLY.some(rule => rule.test(path));
        const line = index => `${path}:${source.slice(0, index).split('\n').length}`;
        for (const m of source.matchAll(new RegExp(String.raw`\b(t|tHtml)\(\s*[\w.]+\s*,\s*` + STRING, 'g'))) add(unquote(m[2]), line(m.index));
        for (const m of source.matchAll(new RegExp(String.raw`\bmsg\(\s*` + STRING + String.raw`\s*\)`, 'g'))) add(unquote(m[1]), line(m.index));
        for (const m of source.matchAll(new RegExp(String.raw`\btPlural\(\s*[\w.]+\s*,\s*[^,]+,\s*` + STRING + String.raw`\s*,\s*` + STRING, 'g'))) {
            add(unquote(m[2]), line(m.index)); plurals.add(unquote(m[2]));
        }
        for (const m of source.matchAll(/\b(t|tHtml|tPlural|msg)\(\s*(?:[\w.]+\s*,\s*)?`/g)) problems.push(`${line(m.index)}: a template literal as a message id; use {placeholders}`);
        if (!people) continue;
        // invariant(condition, 'code', 'message' …) and new AppError(status, 'code', 'message' …).
        // The message is followed by `,` or `)`, so a list such as ['none', 'login', 'consent'] in the condition is not one.
        for (const m of source.matchAll(new RegExp(String.raw`(?:\binvariant\([\s\S]*?|\bnew AppError\(\s*\d+\s*),\s*'[a-z_]+'\s*,\s*(?:` + STRING + String.raw`(?=\s*[,)])|(\`))`, 'g'))) {
            if (m[2]) problems.push(`${line(m.index + m[0].length)}: a template literal as an error message; use {placeholders} and vars`);
            else add(unquote(m[1]), line(m.index + m[0].length));
        }
    }
    return { ids, plurals, problems };
}
const placeholders = text => [...String(text).matchAll(/\{([a-z][a-z0-9_]*)\}/gi)].map(m => m[1]).sort().join(',');
const tags = text => [...String(text).matchAll(/<\/?(\d)>/g)].map(m => m[0]).sort().join(',');
// Problems with one catalogue against the extracted ids: missing, orphaned, wrong placeholders or tags, wrong plural forms.
export function checkCatalogue(locale, catalogue, { ids, plurals }) {
    const problems = [], categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    if (!Object.isFrozen(catalogue)) problems.push(`${locale}: the catalogue must be frozen`);
    for (const id of ids.keys()) if (!Object.hasOwn(catalogue, id)) problems.push(`${locale}: missing ${JSON.stringify(id)} (${ids.get(id)})`);
    for (const [id, value] of Object.entries(catalogue)) {
        if (!ids.has(id)) { problems.push(`${locale}: orphan ${JSON.stringify(id)}`); continue; }
        const forms = plurals.has(id) && value && typeof value === 'object' ? value : null;
        if (plurals.has(id) && !forms) { problems.push(`${locale}: ${JSON.stringify(id)} needs plural forms {${categories.join(', ')}}`); continue; }
        if (!forms && typeof value !== 'string') { problems.push(`${locale}: ${JSON.stringify(id)} must be a string`); continue; }
        if (forms) for (const name of Object.keys(forms)) if (!categories.includes(name)) problems.push(`${locale}: ${JSON.stringify(id)} has plural form ${name}, which ${locale} does not use`);
        if (forms && !Object.hasOwn(forms, 'other')) problems.push(`${locale}: ${JSON.stringify(id)} lacks the plural form other`);
        for (const text of forms ? Object.values(forms) : [value]) {
            if (typeof text !== 'string' || !text.trim()) { problems.push(`${locale}: ${JSON.stringify(id)} has an empty translation`); continue; }
            const want = plurals.has(id) ? placeholders(id).split(',').filter(name => name !== 'count').join(',') : placeholders(id);
            const have = plurals.has(id) ? placeholders(text).split(',').filter(name => name !== 'count').join(',') : placeholders(text);
            if (want !== have) problems.push(`${locale}: ${JSON.stringify(id)} has placeholders {${have}}, not {${want}}`);
            if (tags(id) !== tags(text)) problems.push(`${locale}: ${JSON.stringify(id)} must keep the tags ${tags(id) || '(none)'}`);
            if (/[<>]/.test(text.replace(/<\/?\d>/g, ''))) problems.push(`${locale}: ${JSON.stringify(id)} adds markup`);
        }
    }
    return problems;
}
export async function checkAll() {
    const extracted = await extract(), { catalogues } = await import(pathToFileURL(SRC + 'i18n/index.mjs'));
    const problems = [...extracted.problems];
    for (const [locale, catalogue] of catalogues) if (locale !== 'en') problems.push(...checkCatalogue(locale, catalogue, extracted));
    return { problems, count: extracted.ids.size, locales: [...catalogues.keys()] };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, locale] = process.argv.slice(2);
    if (command === 'ids' || command === 'missing') {
        const { ids, plurals } = await extract(), { catalogues } = await import(pathToFileURL(SRC + 'i18n/index.mjs'));
        const catalogue = command === 'missing' ? catalogues.get(locale) : {};
        if (!catalogue) { console.error(`Unknown locale ${locale}.`); process.exit(1); }
        const out = [...ids].filter(([id]) => !Object.hasOwn(catalogue, id)).map(([id, where]) => ({ id, where, ...(plurals.has(id) ? { plural: true } : {}) }));
        console.log(JSON.stringify(out, null, 1));
    } else {
        const { problems, count, locales } = await checkAll();
        for (const problem of problems.slice(0, 50)) console.error(problem);
        if (problems.length > 50) console.error(`… and ${problems.length - 50} more`);
        if (problems.length) process.exit(1);
        console.log(`Checked ${count} message ids in ${locales.join(', ')}.`);
    }
}
