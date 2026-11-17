#!/usr/bin/env node
// A scripted reference agent for live tests against imprim-probe. It connects through the device flow, then checks
// discovery, the audience boundary, expiry, refresh, the lost-response retry, reuse detection, and that revocation
// reaches the app. It never prints a token, a code or a secret.
//
//   node examples/mcp-probe/agent/run.mjs check  --resource <MCP URL> [--app-secret-file <path>]
//   node examples/mcp-probe/agent/run.mjs grants --resource <MCP URL> --app-secret-file <path>
//   node examples/mcp-probe/agent/run.mjs revoke <grant_id> --resource <MCP URL> --app-secret-file <path>
//   node examples/mcp-probe/agent/run.mjs invite <email> --resource <MCP URL> --app-secret-file <path>
//
// The app secret (from setup.mjs) is needed only for the app's own calls: the grant list, revocation, introspection
// and invitations. `check` needs one person to approve the agent in a browser.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    resource: { type: 'string' }, 'app-secret-file': { type: 'string' }, 'app-id': { type: 'string', default: 'probe' } } });
const [command = 'check', argument] = positionals;
const resource = values.resource;
if (!resource || !/^https:\/\/[^/]+\/w\/[a-z0-9-]+\/mcp$/.test(resource)) usage('--resource must be a workspace MCP URL such as https://imprim-probe.vibernt.ai/w/team-one/mcp');
const origin = new URL(resource).origin, agentId = `${origin}/agent/client.json`;
const secret = values['app-secret-file'] ? readFileSync(values['app-secret-file'], 'utf8').trim() : null;
const appAuth = secret && `Basic ${btoa(`${encodeURIComponent(values['app-id'])}:${encodeURIComponent(secret)}`)}`;

function usage(message) { console.error(message); process.exit(2); }
const results = [];
function check(name, ok, detail = '') {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
    return ok;
}
async function read(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text.slice(0, 200) }; }
}
async function form(url, body, headers = {}) {
    const response = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
    return { status: response.status, body: await read(response) };
}
const claimsOf = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));

async function discover() {
    const challenge = await fetch(resource, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const header = challenge.headers.get('www-authenticate') || '';
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    check('the MCP server challenges an unauthenticated call', challenge.status === 401 && Boolean(metadataUrl), `HTTP ${challenge.status}`);
    const metadata = await read(await fetch(metadataUrl));
    check('resource metadata names this exact resource', metadata?.resource === resource);
    const issuer = metadata?.authorization_servers?.[0];
    const server = await read(await fetch(`${issuer}/.well-known/oauth-authorization-server`));
    check('authorization server metadata comes from the named issuer', server?.issuer === issuer, issuer);
    check('the issuer accepts client ID metadata documents', server?.client_id_metadata_document_supported === true);
    return { issuer, server };
}

async function mcp(url, token, method, params, id) {
    const message = id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
    return fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify(message) });
}
async function whoami(token, url = resource) {
    const opened = await mcp(url, token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'imprim-probe-agent', version: '1.0.0' } }, 1);
    if (opened.status !== 200) return { status: opened.status };
    await mcp(url, token, 'notifications/initialized', {});
    const called = await mcp(url, token, 'tools/call', { name: 'whoami', arguments: {} }, 2);
    return { status: called.status, facts: called.status === 200 ? (await read(called))?.result?.structuredContent : null };
}

async function deviceFlow(server) {
    const started = await form(server.device_authorization_endpoint, { client_id: agentId, resource, scope: 'probe.read' });
    if (!check('device authorization starts', started.status === 200, started.body?.error || '')) return null;
    const device = started.body;
    console.error(`\n  Approve the agent: open ${device.verification_uri_complete}\n  (or ${device.verification_uri} and enter ${device.user_code}), sign in, and approve.\n`);
    let interval = device.interval || 5;
    const deadline = Date.now() + device.expires_in * 1000;
    while (Date.now() < deadline) {
        await sleep(interval * 1000);
        const polled = await form(server.token_endpoint, { grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: agentId, resource });
        if (polled.status === 200) { check('the approved device code redeems once', true); return polled.body; }
        if (polled.body?.error === 'authorization_pending') continue;
        if (polled.body?.error === 'slow_down') { interval += 5; continue; }
        check('the device code is approved', false, polled.body?.error || `HTTP ${polled.status}`);
        return null;
    }
    check('the device code is approved before it expires', false);
    return null;
}

const refresh = (server, token) => form(server.token_endpoint, { grant_type: 'refresh_token', refresh_token: token, client_id: agentId, resource });
const introspect = (issuer, token) => form(`${issuer}/introspect`, { token }, { authorization: appAuth });
async function grantList(issuer) {
    const response = await fetch(`${issuer}/v1/grants?resource=${encodeURIComponent(resource)}`, { headers: { authorization: appAuth } });
    return { status: response.status, body: await read(response) };
}

async function checkAll() {
    const { issuer, server } = await discover();
    let tokens = await deviceFlow(server);
    if (!tokens) return;
    const first = claimsOf(tokens.access_token);
    check('the access token lives at most 60 seconds', first.exp - first.iat <= 60, `${first.exp - first.iat} s`);
    check('the token audience is exactly this resource', first.aud === resource);

    const me = await whoami(tokens.access_token);
    check('whoami answers with the token', me.status === 200, `HTTP ${me.status}`);
    check('the token names the person, the agent and the grant separately',
        Boolean(me.facts?.person && me.facts?.grant) && me.facts?.agent === agentId && me.facts?.person !== me.facts?.agent,
        me.facts ? `person ${me.facts.person}, grant ${me.facts.grant}` : '');
    const grant = me.facts?.grant;

    const other = resource.replace(/\/w\/[a-z0-9-]+\/mcp$/, '/w/team-two/mcp');
    if (other !== resource) check('the same token fails at another workspace', (await whoami(tokens.access_token, other)).status === 401);

    if (appAuth) {
        const listed = await grantList(issuer);
        check('the app grant API lists this grant', listed.status === 200 && listed.body?.grants?.some(g => g.grant_id === grant), `HTTP ${listed.status}`);
        check('introspection reports the token active', (await introspect(issuer, tokens.access_token)).body?.active === true);
        check('introspection reports a made-up token inactive', (await introspect(issuer, 'not-a-token')).body?.active === false);
    }

    const wait = first.exp * 1000 - Date.now() + 2000;
    console.error(`  Waiting ${Math.ceil(wait / 1000)} s for the access token to expire.`);
    await sleep(Math.max(0, wait));
    check('an expired access token is refused', (await whoami(tokens.access_token)).status === 401);
    const renewed = await refresh(server, tokens.refresh_token);
    check('refresh returns a new pair', renewed.status === 200 && renewed.body?.refresh_token !== tokens.refresh_token, renewed.body?.error || '');
    if (renewed.status !== 200) return;
    tokens = renewed.body;
    check('the refreshed access token works', (await whoami(tokens.access_token)).status === 200);

    // A lost response: the agent refreshed, never saw the answer, and retries with the token it still has.
    const lost = await refresh(server, tokens.refresh_token);
    const retried = await refresh(server, tokens.refresh_token);
    check('a retry within 10 seconds of a lost response is accepted', lost.status === 200 && retried.status === 200, retried.body?.error || '');
    const next = await refresh(server, retried.body?.refresh_token);
    check('the retried pair keeps working', next.status === 200, next.body?.error || '');
    const lastAccess = next.body?.access_token;
    const revokedAt = Date.now();
    // Whoever holds the lost replacement now trips reuse detection, which revokes the whole grant.
    const trap = await refresh(server, lost.body?.refresh_token);
    check('using the lost replacement is refused', trap.status === 400 && trap.body?.error === 'invalid_grant', trap.body?.error || `HTTP ${trap.status}`);
    const after = await refresh(server, next.body?.refresh_token);
    check('reuse revoked the whole grant', after.status === 400 && after.body?.error === 'invalid_grant', after.body?.error || `HTTP ${after.status}`);

    if (appAuth) {
        const listed = await grantList(issuer);
        check('the app grant API no longer lists the grant', listed.status === 200 && !listed.body?.grants?.some(g => g.grant_id === grant));
        check('introspection reports the last token inactive', (await introspect(issuer, lastAccess)).body?.active === false);
    }
    // The last access token is still unexpired. The app refuses it early only if the revocation event arrived.
    const expires = claimsOf(lastAccess).exp * 1000;
    let refused = null;
    while (Date.now() < expires) {
        if ((await whoami(lastAccess)).status === 401) { refused = Date.now(); break; }
        await sleep(3000);
    }
    check('the revocation event reached the app before the token expired', refused !== null,
        refused ? `${Math.round((refused - revokedAt) / 1000)} s after the grant was revoked` : 'only expiry stopped it');
}

async function main() {
    if (command === 'check') await checkAll();
    else {
        if (!appAuth) usage('This command needs --app-secret-file.');
        const { issuer } = await discover();
        if (command === 'grants') {
            const listed = await grantList(issuer);
            if (listed.status !== 200) usage(`Grant list failed: HTTP ${listed.status} ${listed.body?.error || ''}`);
            for (const g of listed.body.grants) console.log([g.grant_id, g.sub, g.agent_name, g.agent_verified ? 'verified host' : 'self-registered', g.scope,
                new Date(g.created).toISOString(), g.last_used ? new Date(g.last_used).toISOString() : 'never'].join('  '));
            if (!listed.body.grants.length) console.log('No live grants on this resource.');
        } else if (command === 'revoke') {
            if (!argument) usage('revoke needs a grant id.');
            const revoked = await form(`${issuer}/v1/grants/revoke`, { grant_id: argument }, { authorization: appAuth });
            check('the app revokes the grant', revoked.status === 200 && revoked.body?.revoked === true, revoked.body?.error || '');
        } else if (command === 'invite') {
            if (!argument?.includes('@')) usage('invite needs an email address.');
            const response = await fetch(`${issuer}/v1/invitations`, { method: 'POST', headers: { authorization: appAuth, 'content-type': 'application/json' }, body: JSON.stringify({ email: argument }) });
            const body = await read(response);
            check('the invitation is accepted', response.status === 200 && body?.accepted === true, body?.error || `HTTP ${response.status}`);
        } else usage(`Unknown command: ${command}`);
    }
    const failed = results.filter(ok => !ok).length;
    if (results.length) console.log(`\n${results.length - failed} passed, ${failed} failed.`);
    process.exitCode = failed ? 1 : 0;
}
await main();
