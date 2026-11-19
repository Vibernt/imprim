// Copies Fire's static assets from the pinned fire-design package into the Worker's static assets, with Fire's
// LICENSE and NOTICE (its fonts', Lucide's and Lit's licences), so the served copy carries its own terms.
import { cp, copyFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pkg = new URL('../node_modules/fire-design/', import.meta.url);
const source = fileURLToPath(new URL('fire/', pkg));
const target = fileURLToPath(new URL('../apps/server/public/fire/', import.meta.url));
if (!(await stat(source).catch(() => null))?.isDirectory())
    throw new Error(`Fire is not installed at ${source}. Run npm ci first.`);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
for (const file of ['LICENSE', 'NOTICE']) await copyFile(fileURLToPath(new URL(file, pkg)), `${target}${file}`);
console.log('Copied Fire assets, LICENSE and NOTICE to apps/server/public/fire.');
