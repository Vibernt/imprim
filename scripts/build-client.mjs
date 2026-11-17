import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Explicit dependency order keeps the vendored artifact deterministic and dependency-free.
const modules = ['resources', 'backchannel', 'jwt', 'dpop', 'workspaces', 'index'];
const sources = await Promise.all(modules.map(name => readFile(new URL(`../packages/imprim-client/${name}.mjs`, import.meta.url), 'utf8')));
const body = sources.map((source, index) => {
    const withoutImports = source.replace(/^import .*from '\.\/[^']+';\n/gm, '');
    return index === modules.length - 1 ? withoutImports : withoutImports.replace(/^export /gm, '');
}).join('\n');
const { version } = JSON.parse(await readFile(new URL('../packages/imprim-client/package.json', import.meta.url), 'utf8'));
const sha256 = createHash('sha256').update(body).digest('hex');
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/imprim-client.mjs', import.meta.url), `// imprim-client ${version} body-sha256 ${sha256}\n${body}`);
console.log(`Built imprim-client ${version} ${sha256}`);
