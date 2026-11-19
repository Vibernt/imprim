// Check the production build, its Fire slim report and size budgets, then lint and smoke-test the browser.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const cwd = new URL('../', import.meta.url);
const fire = dirname(createRequire(import.meta.url).resolve('fire-design/package.json'));
const steps = [
    ['npm', 'run', 'build'],
    [process.execPath, join(fire, 'scripts/slim.mjs'), '--verify', 'dist'],
    [process.execPath, 'scripts/budgets.mjs'],
    ['npm', 'run', 'lint:markup', '--', 'src', 'index.html'],
    ['npm', 'run', 'lint:css'],
    [process.execPath, '--test', 'scripts/smoke.test.mjs', 'scripts/admin-realm-smoke.test.mjs'],
];
for (const [command, ...args] of steps) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
