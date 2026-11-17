import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function files(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.wrangler'].includes(entry.name)) continue;
        const path = `${dir}/${entry.name}`;
        out.push(...(entry.isDirectory() ? await files(path) : [path]));
    }
    return out;
}
let count = 0;
for (const path of await files('.')) {
    if (path.endsWith('/package.json')) {
        const pkg = JSON.parse(await readFile(path, 'utf8'));
        for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies'])
            if (Object.keys(pkg[kind] || {}).length) throw new Error(`${path}: runtime dependencies forbidden`);
    }
    if (!path.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    if (path.startsWith('./apps/server/src/')) {
        const source = await readFile(path, 'utf8');
        // `from` followed by whitespace, as in an import statement; a string such as 'from' is not an import.
        for (const [, specifier] of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]+)/g))
            if (!specifier.startsWith('.')) throw new Error(`${path}: unexpected runtime import ${specifier}`);
    }
    count++;
}
console.log(`Checked ${count} ESM files; syntax and zero runtime dependencies.`);
// Translations: every people-facing message id in every shipped language, with matching placeholders (scripts/i18n.mjs).
const { checkAll } = await import('./i18n.mjs');
const translations = await checkAll();
if (translations.problems.length) throw new Error(`Translation catalogues:\n${translations.problems.slice(0, 20).join('\n')}${translations.problems.length > 20 ? `\n… and ${translations.problems.length - 20} more` : ''}`);
console.log(`Checked ${translations.count} message ids in ${translations.locales.join(', ')}.`);
