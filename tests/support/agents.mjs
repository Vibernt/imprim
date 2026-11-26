import assert from 'node:assert/strict';
import { world, cookieJar } from './world.mjs';
import { ensureUser } from '../../apps/server/src/services/admission.mjs';
import { issueSession } from '../../apps/server/src/auth/session.mjs';
import { challengeOf } from '../../apps/server/src/lib/crypto.mjs';
export const resource = 'https://app.example/w/team-one/mcp';
export const metadataId = 'https://agent.example/client.json';
export const redirectUri = 'http://127.0.0.1:4567/callback';
// The device grant is declared explicitly: a document without grant_types gets authorization_code and refresh only.
export const metadata = { client_id: metadataId, client_name: 'Example Agent', redirect_uris: ['http://127.0.0.1/callback', 'http://[::1]/callback', 'http://localhost/callback', 'https://agent.example/callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'] };
export async function agentWorld(t) {
    const w = await world(t), events = [];
    w.env.LOGOUT_QUEUE = { async send(event) { events.push(event); } };
    w.env.DB.db.prepare(`UPDATE clients SET agent_access='on',agent_registration_methods='["metadata_document","dynamic"]',
        agent_scope_catalogue='{"read":"Read workspace","write":"Edit workspace"}',agent_resource_prefixes='["https://app.example/w/"]',branding='{"name":"Example App"}' WHERE id='app'`).run();
    const network = { calls: [], document: metadata, cache: 'max-age=600', addresses: ['93.184.216.34'], status: 200 };
    t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
        const url = String(input); network.calls.push({ url, init });
        assert.equal(init.redirect, 'manual');
        if (url.startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0, Answer: network.addresses.map(data => ({ type: data.includes(':') ? 28 : 1, data })) });
        if (url.startsWith('https://challenges.cloudflare.com/')) return Response.json({ success: true, action: 'sign_in', hostname: 'id.example.com' });
        if (url === metadataId) return Response.json(network.document, { status: network.status, headers: { 'cache-control': network.cache } });
        throw Error('Unexpected network request: ' + url);
    });
    const user = await ensureUser(w.env, 'person@example.com');
    const signed = await issueSession(w.env, user, 'email');
    const cookie = signed.cookies.map(c => c.split(';')[0]).join('; '), csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const form = (path, body, jar = '', headers = {}) => w.call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie: jar, ...headers }, body: new URLSearchParams(body) });
    const query = async (changes = {}) => {
        const values = { client_id: metadataId, resource, redirect_uri: redirectUri, scope: 'read', state: 'state', response_type: 'code',
            code_challenge: await challengeOf(w.verifier), code_challenge_method: 'S256', ...changes };
        for (const key of Object.keys(values)) if (values[key] === null) delete values[key];
        return values;
    };
    const start = async (changes = {}, jar = cookie) => {
        const values = await query(changes);
        const response = await w.call('/authorize?' + new URLSearchParams(values), { headers: { cookie: jar } });
        const location = response.headers.get('location');
        return { response, cookie: [jar,cookieJar(response)].filter(Boolean).join('; '),
            id: location ? new URL(location).searchParams.get('request_id') : null, scopes: values.scope?.split(' ') };
    };
    const approve = (flow, decision = 'approve') => form('/agent/consent', [
        ['request_id', flow.id], ['csrf', csrf], ['decision', decision], ...flow.scopes.map(scope => ['scope', scope])
    ], flow.cookie);
    const exchange = (code, changes = {}) => form('/token', { grant_type: 'authorization_code', client_id: metadataId, resource, code, redirect_uri: redirectUri, code_verifier: w.verifier, ...changes });
    const refresh = (token, changes = {}) => form('/token', { grant_type: 'refresh_token', client_id: metadataId, resource, refresh_token: token, ...changes });
    const grant = async (changes = {}) => {
        const flow = await start(changes); assert.equal(flow.response.status, 303, await flow.response.clone().text());
        const approved = await approve(flow); assert.equal(approved.status, 303, await approved.clone().text());
        const code = new URL(approved.headers.get('location')).searchParams.get('code');
        const response = await exchange(code, changes.client_id ? { client_id: changes.client_id } : {});
        assert.equal(response.status, 200, await response.clone().text());
        return { flow, code, tokens: await response.json() };
    };
    return { ...w, events, network, user, signed, cookie, csrf, form, query, start, approve, exchange, refresh, grant };
}
export async function error(response, expected, status) {
    if (status) assert.equal(response.status, status);
    const body = await response.json(); assert.equal(body.error, expected, JSON.stringify(body));
}
