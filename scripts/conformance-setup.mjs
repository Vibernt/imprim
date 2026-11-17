#!/usr/bin/env node
// Sets up an Imprim deployment for the OpenID Foundation conformance suite (docs/CERTIFICATION.md). Offline: nothing
// is registered and nothing leaves this machine.
//
//   node scripts/conformance-setup.mjs --issuer https://id-staging.vibernt.ai --alias imprim-staging \
//       --email conformance@example.com --out ~/.imprim-conformance > conformance.sql
//
// --out is a new directory, mode 0700, that receives the suite's configuration (plan.json, with the test clients'
// secrets, for pasting into the suite) and the test person's sign-in (person.txt), each mode 0600. Stdout is SQL to
// review and apply: three classic OpenID Connect clients whose callbacks are the suite's, signing in by password
// only and admitting only the test person, plus that person with a random password.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { clientSeedSql } from './seed-client.mjs';
import { hashPassword } from '../apps/server/src/auth/password-hash.mjs';
import { normalizeEmail } from '../apps/server/src/services/admission.mjs';

export const SUITE = 'https://www.certification.openid.net';
export const CLIENTS = ['oidf-basic', 'oidf-basic-2', 'oidf-post'];
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
// One test client: the suite's callback, sign-out and back-channel URLs for this alias.
export function conformanceClient(id, alias, secretHash) {
    const base = `${SUITE}/test/a/${alias}`;
    return {
        id, secret_hash: secretHash, classic_oidc: 'on',
        redirect_uris: [`${base}/callback`], post_logout_uris: [`${base}/post_logout_redirect`], backchannel_uri: `${base}/backchannel_logout`,
        signup_policy: 'invited', sign_in_methods: ['password'], branding: { name: `OpenID conformance (${id})` }
    };
}
// The suite's configuration for every plan: discovery, the client, a second client, and the client_secret_post client.
export function planConfig(issuer, alias, secrets) {
    return {
        alias, description: `Imprim at ${issuer}`, server: { discoveryUrl: `${issuer}/.well-known/openid-configuration` },
        client: { client_id: CLIENTS[0], client_secret: secrets[CLIENTS[0]] },
        client2: { client_id: CLIENTS[1], client_secret: secrets[CLIENTS[1]] },
        client_secret_post: { client_id: CLIENTS[2], client_secret: secrets[CLIENTS[2]] }
    };
}
export async function personSql(id, email, password, now = Date.now()) {
    const hash = await hashPassword(password);
    return [`INSERT INTO users(id,realm_id,email,email_verified,status,created) VALUES(${[id, 'default', email, 1, 'active', now].map(sql).join(',')});`,
        `INSERT INTO user_passwords(user_id,algorithm,iterations,salt,hash,created,updated) VALUES(${[id, hash.algorithm, hash.iterations, hash.salt, hash.hash, now, now].map(sql).join(',')});`,
        ...CLIENTS.map(client => `INSERT INTO client_admissions(user_id,client_id,created) VALUES(${[id, client, now].map(sql).join(',')});`)].join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { values } = parseArgs({ options: { issuer: { type: 'string' }, alias: { type: 'string' }, email: { type: 'string' }, out: { type: 'string' } } });
    const fail = message => { console.error(message); process.exit(2); };
    if (!values.issuer || !values.alias || !values.email || !values.out) fail('Usage: node scripts/conformance-setup.mjs --issuer <https origin> --alias <suite alias> --email <test person> --out <new directory> > conformance.sql');
    if (!/^https:\/\/[a-z0-9.-]+$/.test(values.issuer)) fail('--issuer must be an https origin.');
    if (!/^[a-z0-9-]{3,40}$/.test(values.alias)) fail('--alias is 3 to 40 lowercase letters, digits and dashes.');
    const email = normalizeEmail(values.email);
    // recursive: false refuses an existing directory, so earlier secrets are never overwritten.
    mkdirSync(values.out, { mode: 0o700 });
    const secrets = Object.fromEntries(CLIENTS.map(id => [id, randomBytes(32).toString('base64url')]));
    const password = randomBytes(18).toString('base64url');
    const write = (name, text) => writeFileSync(`${values.out}/${name}`, text, { mode: 0o600, flag: 'wx' });
    write('plan.json', JSON.stringify(planConfig(values.issuer, values.alias, secrets), null, 2) + '\n');
    write('person.txt', `${email}\n${password}\n`);
    let out = '-- OpenID conformance clients and test person. Review before applying.\n';
    for (const id of CLIENTS) out += clientSeedSql(conformanceClient(id, values.alias, createHash('sha256').update(secrets[id]).digest('hex')));
    out += await personSql(randomUUID(), email, password);
    process.stdout.write(out);
}
