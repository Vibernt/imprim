#!/usr/bin/env node
// A scripted reference agent for live tests against imprim-probe. It connects through the device or loopback flow, then checks
// discovery, the audience boundary, expiry, refresh, the lost-response retry, reuse detection, and that revocation
// reaches the app. It never prints a token, a code or a secret.
//
//   node examples/mcp-probe/agent/run.mjs check  --resource <MCP URL> [--app-secret-file <path>] [--flow device|loopback]
//   node examples/mcp-probe/agent/run.mjs grants --resource <MCP URL> --app-secret-file <path>
//   node examples/mcp-probe/agent/run.mjs revoke <grant_id> --resource <MCP URL> --app-secret-file <path>
//   node examples/mcp-probe/agent/run.mjs invite <email> --resource <MCP URL> --app-secret-file <path>
//   node examples/mcp-probe/agent/run.mjs name <workspace_id> <resource> --name "<text>" --app-secret-file <path>
//   node examples/mcp-probe/agent/run.mjs machine <workspace_id> --app-secret-file <path> [--resource https://probe.example.com/mcp]
//
// --resource accepts https://probe.example.com/mcp or https://probe.example.com/w/team-one/mcp.
// --flow loopback signs in as a desktop agent does: a browser approval that returns to a listener on 127.0.0.1
// (RFC 8252), instead of the device flow.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { IdentityError } from '../../../packages/imprim-client/index.mjs';
import { claimsOf, discover, failure, form, read, whoami } from './http.mjs';
import { deviceFlow, loopbackFlow } from './flows.mjs';
import { machine, nameResource } from './workspaces.mjs';

const DEFAULT_ORIGIN = 'https://probe.example.com';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    resource: { type: 'string' }, name: { type: 'string' }, 'app-secret-file': { type: 'string' },
    'app-id': { type: 'string', default: 'probe' }, flow: { type: 'string', default: 'device' } } });
const [command = 'check', argument, namedResource] = positionals;
if (!['check', 'grants', 'revoke', 'invite', 'name', 'machine'].includes(command)) usage('Use check, grants, revoke, invite, name or machine.');
if (!['device', 'loopback'].includes(values.flow)) usage('--flow is device or loopback.');
if (command === 'name' && (!argument || !namedResource || !values.name?.trim())) usage('name needs a workspace id, resource and --name.');
if (command === 'machine' && !argument) usage('machine needs a workspace id.');
const resource = command === 'name' ? namedResource : values.resource ?? (command === 'machine' ? `${DEFAULT_ORIGIN}/mcp` : undefined);
if (!resource || !/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/w\/[a-z0-9][a-z0-9-]{0,39})?\/mcp$/.test(resource) ||
    URL.parse(resource)?.href !== resource) usage('Use a canonical HTTPS resource URL such as https://probe.example.com/mcp or https://probe.example.com/w/team-one/mcp.');
const origin = new URL(resource).origin, agentId = `${origin}/agent/client.json`;
const product = resource === `${origin}/mcp`;
if (command === 'machine' && !product) usage('machine needs the product MCP URL ending in /mcp, without a workspace path.');
const secret = readSecret(values['app-secret-file']);
const appAuth = secret && `Basic ${btoa(`${encodeURIComponent(values['app-id'])}:${encodeURIComponent(secret)}`)}`;

function usage(message) { console.error(message); process.exit(2); }
function readSecret(path) {
    if (!path) return null;
    try { return readFileSync(path, 'utf8').trim(); }
    catch (error) { usage(`Could not read --app-secret-file (${error.code}).`); }
}
const results = [];
function check(name, ok, detail = '', measurement = false) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && (!ok || measurement) ? `: ${detail}` : ''}`);
    return ok;
}
const refresh = (server, token) => form(server.token_endpoint, { grant_type: 'refresh_token', refresh_token: token, client_id: agentId, resource });
const introspect = (issuer, token) => form(`${issuer}/introspect`, { token }, { authorization: appAuth });
async function grantList(issuer) {
    const response = await fetch(`${issuer}/v1/grants?resource=${encodeURIComponent(resource)}`, { redirect: 'manual', headers: { authorization: appAuth } });
    return { status: response.status, body: await read(response) };
}

async function checkAll({ issuer, server }) {
    if (product) console.error('  Choose a workspace on the consent page.');
    let tokens = values.flow === 'loopback' ? await loopbackFlow(server, resource, agentId, check) : await deviceFlow(server, resource, agentId, check);
    if (!tokens) return;
    const replayCode = tokens.replay;
    const first = claimsOf(tokens.access_token);
    const lifetime = first.exp - first.iat;
    check('the access token lives at most 60 seconds', lifetime > 0 && lifetime <= 60, `${lifetime} s`, true);
    check('the token audience is exactly this resource', first.aud === resource);

    const me = await whoami(tokens.access_token, resource);
    check('whoami answers with the token', me.status === 200, `HTTP ${me.status}`);
    check('the token names the person, the agent and the grant separately',
        Boolean(me.facts?.person && me.facts?.grant) && me.facts?.agent === agentId && me.facts?.person !== me.facts?.agent);
    const grant = me.facts?.grant;

    if (product) {
        check('the token carries the chosen workspace', typeof first.workspace_id === 'string' && me.facts?.workspace_id === first.workspace_id);
        const other = await whoami(tokens.access_token, `${origin}/w/team-one/mcp`);
        check('the same token fails at a workspace endpoint', other.status === 401, `HTTP ${other.status}`);
    } else {
        const other = `${origin}/w/team-two/mcp`;
        if (other !== resource) check('the same token fails at another workspace', (await whoami(tokens.access_token, other)).status === 401);
    }

    if (appAuth) {
        const listed = await grantList(issuer);
        check('the app grant API lists this grant', listed.status === 200 && listed.body?.grants?.some(g => g.grant_id === grant), `HTTP ${listed.status}`);
        check('introspection reports the token active', (await introspect(issuer, tokens.access_token)).body?.active === true);
        check('introspection reports a made-up token inactive', (await introspect(issuer, 'not-a-token')).body?.active === false);
    }

    const wait = first.exp * 1000 - Date.now() + 2000;
    console.error(`  Waiting ${Math.ceil(wait / 1000)} s for the access token to expire.`);
    await sleep(Math.max(0, wait));
    check('an expired access token is refused', (await whoami(tokens.access_token, resource)).status === 401);
    const renewed = await refresh(server, tokens.refresh_token);
    if (!check('refresh returns a new pair', renewed.status === 200 && typeof renewed.body?.refresh_token === 'string' &&
        renewed.body.refresh_token !== tokens.refresh_token, failure(renewed))) return;
    tokens = renewed.body;
    check('the refreshed access token works', (await whoami(tokens.access_token, resource)).status === 200);

    // A lost response: the agent refreshed, never saw the answer, and retries with the token it still has.
    const lost = await refresh(server, tokens.refresh_token);
    const retried = await refresh(server, tokens.refresh_token);
    if (!check('a retry within 10 seconds of a lost response is accepted', lost.status === 200 && retried.status === 200,
        `first ${failure(lost)}, retry ${failure(retried)}`)) return;
    const next = await refresh(server, retried.body?.refresh_token);
    if (!check('the retried pair keeps working', next.status === 200, failure(next))) return;
    const lastAccess = next.body?.access_token;
    const revokedAt = Date.now();
    // Whoever holds the lost replacement now trips reuse detection, which revokes the whole grant.
    const trap = await refresh(server, lost.body?.refresh_token);
    check('using the lost replacement is refused', trap.status === 400 && trap.body?.error === 'invalid_grant', failure(trap));
    const after = await refresh(server, next.body?.refresh_token);
    check('reuse revoked the whole grant', after.status === 400 && after.body?.error === 'invalid_grant', failure(after));

    if (appAuth) {
        const listed = await grantList(issuer);
        check('the app grant API no longer lists the grant', listed.status === 200 && !listed.body?.grants?.some(g => g.grant_id === grant));
        check('introspection reports the last token inactive', (await introspect(issuer, lastAccess)).body?.active === false);
    }
    // The last access token is still unexpired. The app refuses it early only if the revocation event arrived.
    const expires = claimsOf(lastAccess).exp * 1000;
    let refused = null;
    while (Date.now() < expires) {
        if ((await whoami(lastAccess, resource)).status === 401) { refused = Date.now(); break; }
        await sleep(3000);
    }
    check('the revocation event reached the app before the token expired', refused !== null,
        refused ? `${Math.round((refused - revokedAt) / 1000)} s after the grant was revoked` : 'only expiry stopped it', true);
    if (replayCode) await replayCode();
}

async function main() {
    if (command !== 'check' && !appAuth) usage('This command needs --app-secret-file.');
    const discovered = await discover(resource, check);
    if (!discovered) return;
    const { issuer, server } = discovered;
    if (command === 'check') await checkAll(discovered);
    else if (command === 'name' || command === 'machine') {
        const app = { issuer, clientId: values['app-id'], clientSecret: secret };
        const options = { app, server, workspaceId: argument, resource, check };
        if (command === 'name') await nameResource({ ...options, name: values.name });
        else await machine(options);
    } else {
        if (command === 'grants') {
            const listed = await grantList(issuer);
            if (listed.status !== 200) usage(`Grant list failed: ${failure(listed)}`);
            for (const g of listed.body.grants) console.log([g.grant_id, g.sub, g.agent_name, g.agent_verified ? 'verified host' : 'self-registered', g.scope,
                new Date(g.created).toISOString(), g.last_used ? new Date(g.last_used).toISOString() : 'never'].join('  '));
            if (!listed.body.grants.length) console.log('No live grants on this resource.');
        } else if (command === 'revoke') {
            if (!argument) usage('revoke needs a grant id.');
            const revoked = await form(`${issuer}/v1/grants/revoke`, { grant_id: argument }, { authorization: appAuth });
            check('the app revokes the grant', revoked.status === 200 && revoked.body?.revoked === true, failure(revoked));
        } else if (command === 'invite') {
            if (!argument?.includes('@')) usage('invite needs an email address.');
            const response = await fetch(`${issuer}/v1/invitations`, { method: 'POST', redirect: 'manual', headers: { authorization: appAuth, 'content-type': 'application/json' }, body: JSON.stringify({ email: argument }) });
            const body = await read(response);
            check('the invitation is accepted', response.status === 201 && body?.accepted === true, failure({ status: response.status, body }));
        }
    }
}
try { await main(); }
catch (error) {
    const detail = error instanceof IdentityError ? error.message : (error.cause?.code || error.code || error.message);
    check(`the ${command} command completes`, false, detail);
}
const failed = results.filter(ok => !ok).length;
if (results.length) console.log(`\n${results.length - failed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
