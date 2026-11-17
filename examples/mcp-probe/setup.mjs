#!/usr/bin/env node
// Makes the probe's app client: a new random secret, written only to --secret-out (mode 0600), and reviewed SQL on
// stdout from scripts/seed-client.mjs. Nothing is registered and nothing leaves this machine.
//
//   node examples/mcp-probe/setup.mjs --secret-out <path> [--origin https://probe.example.com] > probe-client.sql
import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { clientSeedSql } from '../../scripts/seed-client.mjs';

export function probeClient(origin, secretHash) {
    return {
        id: 'probe', secret_hash: secretHash,
        redirect_uris: [`${origin}/callback`],
        backchannel_uri: `${origin}/backchannel`,
        signup_policy: 'invited',
        sign_in_methods: ['email'],
        agent_access: 'on',
        // Both, so a client that registers itself (as ChatGPT may) can be tested too.
        agent_registration_methods: ['metadata_document', 'dynamic'],
        agent_resource_prefixes: [`${origin}/w/`],
        agent_scope_catalogue: { 'probe.read': 'See which person, agent and grant this connection uses' },
        agent_max_grant_days: 7,
        branding: { name: 'Imprim probe' }
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { values } = parseArgs({ options: { 'secret-out': { type: 'string' }, origin: { type: 'string', default: 'https://probe.example.com' } } });
    if (!values['secret-out']) { console.error('Usage: node examples/mcp-probe/setup.mjs --secret-out <path> > probe-client.sql'); process.exit(2); }
    if (!/^https:\/\/[a-z0-9.-]+$/.test(values.origin)) { console.error('--origin must be an https origin.'); process.exit(2); }
    const secret = randomBytes(32).toString('base64url');
    // flag 'wx' refuses to overwrite an existing secret file.
    writeFileSync(values['secret-out'], secret + '\n', { mode: 0o600, flag: 'wx' });
    process.stdout.write(clientSeedSql(probeClient(values.origin, createHash('sha256').update(secret).digest('hex'))));
}
