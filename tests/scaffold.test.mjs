import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('workspace and Worker configuration: neutral template, staging and production environments, no admins or secrets in vars', () => {
    const root = JSON.parse(read('package.json'));
    assert.deepEqual(root.workspaces, ['apps/server', 'packages/imprim-client']);
    for (const path of ['package.json','apps/server/package.json','packages/imprim-client/package.json']) {
        const pkg = JSON.parse(read(path));
        assert.equal(pkg.type, 'module'); assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
        assert.ok(!/vibernt/i.test(pkg.name || ''), `${path} has a neutral name`);
    }
    const config = JSON.parse(read('apps/server/wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
    assert.equal(config.name, 'imprim'); assert.equal(config.main, 'src/worker.mjs');
    assert.equal(config.routes, undefined, 'the template routes nothing');
    assert.equal(config.preview_urls, false); assert.equal(config.workers_dev, false);
    assert.equal(config.observability.logs.invocation_logs, false);
    assert.equal(config.kv_namespaces, undefined, 'the unused CONFIG_CACHE binding is gone');
    assert.deepEqual(Object.keys(config.env).sort(), ['production', 'staging']);
    for (const target of [config, config.env.staging, config.env.production]) {
        assert.equal(target.d1_databases[0].binding, 'DB');
        assert.deepEqual(target.ratelimits.map(x => x.name).sort(), ['AGENT_LIMITER', 'API_LIMITER', 'AUTH_LIMITER']);
        assert.equal(target.send_email[0].name, 'EMAIL'); assert.equal(target.queues.producers[0].binding, 'LOGOUT_QUEUE');
        assert.equal(target.queues.consumers[0].max_retries, 5);
        assert.ok(target.queues.consumers[0].dead_letter_queue);
        assert.deepEqual(target.triggers.crons, ['* * * * *']);
        for (const key of ['ISSUER','ADMIN_EMAILS','SEALING_KEY','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','TURNSTILE_SECRET']) assert.equal(target.vars[key], undefined, key);
    }
    assert.equal(config.env.production.name, 'imprim', 'production uses the neutral Worker name');
    assert.deepEqual(config.env.production.routes, [{ pattern: 'id.example.com', custom_domain: true }]);
    assert.notEqual(config.env.staging.ratelimits[0].namespace_id, config.env.production.ratelimits[0].namespace_id);
    assert.ok(!/@[a-z0-9-]+\.[a-z]+"/i.test(read('apps/server/wrangler.jsonc').replace(/signin@example\.com/g, '')), 'no personal address is committed');
});
