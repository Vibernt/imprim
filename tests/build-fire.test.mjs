import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the Fire asset copy removes stale files and preserves existing output if the source is missing', async t => {
    const root = await mkdtemp(join(tmpdir(), 'imprim-build-fire-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, 'apps/server/public/fire'), source = join(root, 'node_modules/fire-design/fire');
    const script = join(root, 'scripts/build-fire.mjs');
    await mkdir(join(root, 'scripts'));
    await cp(new URL('../scripts/build-fire.mjs', import.meta.url), script);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'stale.css'), 'old');
    assert.notEqual(spawnSync(process.execPath, [script]).status, 0);
    assert.equal(await readFile(join(target, 'stale.css'), 'utf8'), 'old');
    await mkdir(join(source, 'js'), { recursive: true });
    await writeFile(join(source, 'js/core.js'), 'new');
    for (const file of ['LICENSE', 'NOTICE']) await writeFile(join(source, '..', file), file);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(target)).sort(), ['LICENSE', 'NOTICE', 'js']);
    assert.equal(await readFile(join(target, 'NOTICE'), 'utf8'), 'NOTICE');
    assert.equal(await readFile(join(target, 'js/core.js'), 'utf8'), 'new');
});

test('the Wrangler asset directory contains the generated Fire stylesheet and browser modules', async () => {
    const config = await readFile(new URL('../apps/server/wrangler.jsonc', import.meta.url), 'utf8');
    const [, directory] = config.match(/^\s*"assets":\s*\{\s*"directory":\s*"([^"]+)"/m);
    assert.equal(directory, 'public');
    assert.match(config, /"binding": "ASSETS"/);
    for (const file of ['fire.css', 'fire.js', 'js/forms.js', 'js/shell.js', 'js/texture.js', 'js/theme.js']) {
        const generated = await readFile(new URL(`../apps/server/${directory}/fire/${file}`, import.meta.url));
        const vendored = await readFile(new URL(`../node_modules/fire-design/fire/${file}`, import.meta.url));
        assert.deepEqual(generated, vendored, file);
    }
});
