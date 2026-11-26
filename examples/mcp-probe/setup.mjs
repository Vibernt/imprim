#!/usr/bin/env node
// Makes the probe's app client: a new random secret, written only to --secret-out (mode 0600), and reviewed SQL on
// stdout from scripts/seed-client.mjs. Nothing is registered and nothing leaves this machine.
//
//   node examples/mcp-probe/setup.mjs --secret-out <path> [--origin https://probe.example.com] [--product <name>] > probe-client.sql
import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { clientSeedSql } from '../../scripts/seed-client.mjs';
import { validProduct } from '../../apps/server/src/admin/clients.mjs';

export function probeClient(origin, secretHash, product) {
    return {
        id: 'probe', secret_hash: secretHash,
        redirect_uris: [`${origin}/callback`],
        backchannel_uri: `${origin}/backchannel`,
        signup_policy: 'invited',
        sign_in_methods: ['email'],
        agent_access: 'on',
        // Both, so a client that registers itself (as ChatGPT may) can be tested too.
        agent_registration_methods: ['metadata_document', 'dynamic'],
        agent_resource_prefixes: product === undefined ? [`${origin}/w/`] : [`${origin}/w/`, `${origin}/mcp`],
        agent_scope_catalogue: { 'probe.read': 'See which person, agent and grant this connection uses' },
        agent_max_grant_days: 7,
        branding: { name: 'Imprim probe' },
        ...(product === undefined ? {} : { workspaces: 'shared', product, agent_workspace_resources: [`${origin}/mcp`] })
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { values } = parseArgs({ options: { 'secret-out': { type: 'string' }, origin: { type: 'string', default: 'https://probe.example.com' }, product: { type: 'string' } } });
    if (!values['secret-out']) { console.error('Usage: node examples/mcp-probe/setup.mjs --secret-out <path> > probe-client.sql'); process.exit(2); }
    if (!/^https:\/\/[a-z0-9.-]+$/.test(values.origin)) { console.error('--origin must be an https origin.'); process.exit(2); }
    if (values.product !== undefined && !validProduct(values.product)) {
        console.error('--product must be 2–40 lowercase letters, digits or hyphens, starting with a letter.');
        process.exit(2);
    }
    const secret = randomBytes(32).toString('base64url');
    const sql = clientSeedSql(probeClient(values.origin, createHash('sha256').update(secret).digest('hex'), values.product));
    // flag 'wx' refuses to overwrite an existing secret file.
    writeFileSync(values['secret-out'], secret + '\n', { mode: 0o600, flag: 'wx' });
    process.stdout.write(sql);
    if (values.product !== undefined) {
        console.error('Set PRODUCT_RESOURCE=on in examples/mcp-probe/wrangler.jsonc.');
        console.error('For live membership checks, run wrangler secret put APP_SECRET --config examples/mcp-probe/wrangler.jsonc.');
    }
}
