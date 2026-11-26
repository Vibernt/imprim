import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { form, failure, sameOrigin } from './http.mjs';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export async function deviceFlow(server, resource, agentId, check) {
    if (!check('the device endpoint belongs to the named issuer', sameOrigin(server.device_authorization_endpoint, server.issuer))) return null;
    const started = await form(server.device_authorization_endpoint, { client_id: agentId, resource, scope: 'probe.read' });
    if (!check('device authorization starts', started.status === 200, failure(started))) return null;
    const device = started.body;
    if (!check('the device approval address belongs to the named issuer', sameOrigin(device?.verification_uri_complete, server.issuer))) return null;
    // The device flow's point is approving on any device (RFC 8628 3.3): show the address and the code, as a CLI does.
    console.error(`\n  Approve the agent: open ${device.verification_uri_complete}\n  (or ${device.verification_uri} and enter ${device.user_code}) on any device, sign in, and approve.\n`);
    return pollDevice(device, server, resource, agentId, check);
}

async function listen(listener) {
    const listening = once(listener, 'listening');
    listener.listen(0, '127.0.0.1');
    await listening;
}

async function pollDevice(device, server, resource, agentId, check) {
    let interval = device.interval || 5;
    const deadline = Date.now() + device.expires_in * 1000;
    while (Date.now() < deadline) {
        await sleep(interval * 1000);
        const polled = await form(server.token_endpoint, { grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: agentId, resource });
        if (polled.status === 200) { check('the approved device code redeems once', true); return polled.body; }
        if (polled.body?.error === 'authorization_pending') continue;
        if (polled.body?.error === 'slow_down') { interval += 5; continue; }
        check('the device code is approved', false, failure(polled));
        return null;
    }
    check('the device code is approved before it expires', false);
    return null;
}

// A desktop agent's sign-in: PKCE, a one-time listener on 127.0.0.1 (only the port differs from the registered
// http://127.0.0.1/callback), state checked, the code exchanged for the exact redirect URI.
export async function loopbackFlow(server, resource, agentId, check) {
    if (!check('the authorization endpoint belongs to the named issuer', sameOrigin(server.authorization_endpoint, server.issuer))) return null;
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(16).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let answer;
    const answered = new Promise(resolve => { answer = resolve; });
    const listener = createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('The probe agent got an answer. You can close this tab.');
        answer(url.searchParams);
    });
    await listen(listener);
    const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;
    const authorize = `${server.authorization_endpoint}?${new URLSearchParams({ response_type: 'code', client_id: agentId, redirect_uri: redirectUri,
        scope: 'probe.read', resource, state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
    console.error(`\n  Approve the agent: open this address in a browser on this computer, sign in, and approve.\n  ${authorize}\n`);
    const params = await Promise.race([answered, sleep(600000, null, { ref: false })]);
    listener.close();
    if (!check('the browser returns to the loopback listener', params !== null, params ? '' : 'no answer within 10 minutes')) return null;
    if (!check('the answer carries this sign-in state', params.get('state') === state)) return null;
    if (!check('the person approved', params.has('code'))) return null;
    const exchanged = await form(server.token_endpoint, { grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri,
        code_verifier: verifier, client_id: agentId, resource });
    if (!check('the code redeems once for the exact redirect URI', exchanged.status === 200, failure(exchanged))) return null;
    // Replaying a code revokes its grant (RFC 6749 4.1.2), so the replay check runs last, after the grant has ended.
    const replay = async () => {
        const again = await form(server.token_endpoint, { grant_type: 'authorization_code', code: params.get('code'), redirect_uri: redirectUri,
            code_verifier: verifier, client_id: agentId, resource });
        check('a second redemption of the code is refused', again.status === 400 && again.body?.error === 'invalid_grant', failure(again));
    };
    return { ...exchanged.body, replay };
}
