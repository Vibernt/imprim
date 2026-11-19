// Copy only the built Lit shell and its hashed assets. build-fire owns the shared /fire directory.
import { cp, copyFile, rm, stat } from 'node:fs/promises';

const dist = new URL('../apps/web/dist/', import.meta.url);
const publicUi = new URL('../apps/server/public/ui/', import.meta.url);
const assets = new URL('ui/', dist);
const index = new URL('index.html', dist);
if (!(await stat(assets)).isDirectory() || !(await stat(index)).isFile()) throw new Error('Invalid Lit build output.');
await rm(publicUi, { recursive: true, force: true });
await cp(assets, publicUi, { recursive: true });
await copyFile(index, new URL('index.html', publicUi));
