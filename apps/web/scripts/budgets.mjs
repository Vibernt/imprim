import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const manifest = JSON.parse(read('dist/.vite/manifest.json'));
const { budget } = JSON.parse(read('package.json')).fire;
const first = new Set();

function addImports(key) {
    const chunk = manifest[key];
    assert.ok(chunk, `Missing manifest entry: ${key}`);
    if (first.has(chunk.file)) return;
    first.add(chunk.file);
    for (const imported of chunk.imports || []) addImports(imported);
}

addImports('index.html');
addImports('src/screens/account/profile.ts');
const files = new Set(Object.values(manifest).flatMap(chunk => [chunk.file, ...(chunk.css || [])]));
const routes = Object.values(manifest).filter(chunk => chunk.isDynamicEntry).map(chunk => chunk.file);
const sizes = new Map();

console.log('\nFile                                              Raw kB   Gzip kB');
for (const file of [...files].filter(file => /\.(js|css)$/.test(file)).sort()) {
    const bytes = read(`dist/${file}`), gzip = gzipSync(bytes).length / 1000;
    sizes.set(file, gzip);
    console.log(`${file.padEnd(49)} ${(bytes.length / 1000).toFixed(2).padStart(6)} ${gzip.toFixed(2).padStart(9)}`);
}
const branding = manifest['src/screens/admin/branding/screen.ts'];
const tweaks = branding?.dynamicImports?.find(key => key.endsWith('/js/tweaks.js'));
assert.ok(tweaks, 'Branding loads Fire Tweaks dynamically');
assert.ok(!first.has(manifest[tweaks].file), 'The initial app does not load Fire Tweaks');
for (const key of [manifest['index.html'], ...Object.values(manifest).filter(chunk => chunk.isDynamicEntry && chunk !== branding)]) {
    assert.ok(!key.imports?.includes(tweaks), 'Other screens do not import the Tweaks module');
}
const panelCss = bytes => /[.]fd-tweaks[{, ]/.test(String(bytes));
assert.ok(branding.css.some(file => panelCss(read(`dist/${file}`))), 'Branding loads the Tweaks stylesheet');
assert.ok(manifest['index.html'].css.every(file => !panelCss(read(`dist/${file}`))), 'Initial styles omit the Tweaks panel');

const sum = files => [...files].reduce((total, file) => total + sizes.get(file), 0);
const measures = {
    initialJs: sum(first),
    routeJs: Math.max(...routes.map(file => sizes.get(file))),
    css: sum([...files].filter(file => file.endsWith('.css'))),
};
for (const [name, measured] of Object.entries(measures)) {
    const summary = `budget ${name}: ${measured.toFixed(2)} kB gzip of ${budget[name]} kB`;
    assert.ok(measured <= budget[name], summary);
    console.log(`ok ${summary}`);
}
