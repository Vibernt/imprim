import { randomUUID, webcrypto } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { createClient } from '../../../packages/imprim-client/index.mjs';
import { claimsOf, failure, form, whoami } from './http.mjs';

const SCOPE = 'probe.read';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function nameResource({ app, workspaceId, resource, name, check }) {
    const identity = createClient(app);
    const registered = await identity.registerWorkspaceResource(workspaceId, resource, { name });
    check('the app registers the resource name', registered?.workspace_id === workspaceId);
    console.log(JSON.stringify({ resource, name: name.trim(), workspace: registered }, null, 2));
    const repeated = await identity.registerWorkspaceResource(workspaceId, resource, { name });
    check('registering the same name leaves the workspace unchanged', isDeepStrictEqual(registered, repeated));
}

async function waitForApproval(app, workspaceId, requestId) {
    const signal = AbortSignal.timeout(600000);
    const identity = createClient({ ...app, fetch: (url, init) => fetch(url, { ...init, signal }) });
    try {
        while (!signal.aborted) {
            await sleep(5000, undefined, { signal });
            const result = await identity.machineClientRequest(workspaceId, requestId);
            if (result.status !== 'pending') return result;
        }
    } catch (error) {
        if (!signal.aborted) throw error;
    }
    return null;
}

async function machineToken(endpoint, clientId, resource, key, kid) {
    const assertion = `${b64({ alg: 'ES256', kid })}.${b64({
        iss: clientId, sub: clientId, aud: endpoint, jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + 60
    })}`;
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(assertion));
    return form(endpoint, { grant_type: 'client_credentials', client_id: clientId, resource, scope: SCOPE,
        client_assertion_type: ASSERTION_TYPE, client_assertion: `${assertion}.${Buffer.from(signature).toString('base64url')}` });
}

export async function machine({ app, server, workspaceId, resource, check }) {
    const identity = createClient(app);
    const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const kid = randomUUID();
    const jwk = { ...await webcrypto.subtle.exportKey('jwk', publicKey), kid, alg: 'ES256' };
    const receipt = await identity.requestMachineClient(workspaceId, { name: 'Imprim probe worker', jwks: { keys: [jwk] }, scopes: [SCOPE], resources: [resource] });
    const requestId = receipt?.request_id;
    if (!check('the app requests a workspace machine client', typeof requestId === 'string' && /^[a-f0-9]{32}$/.test(requestId) &&
        receipt.approval_url === `${app.issuer}/machine-client?request_id=${requestId}`)) return;
    console.error(`  Ask a workspace owner or admin to approve at ${receipt.approval_url}`);
    const status = await waitForApproval(app, workspaceId, requestId);
    const clientId = status?.service_client_id;
    const detail = status ? (['denied', 'expired'].includes(status.status) ? status.status : 'invalid approval response') : 'no answer within 10 minutes';
    if (!check('the workspace owner or admin approves the machine', status?.status === 'approved' && typeof clientId === 'string', detail)) return;

    try {
        const endpoint = server.token_endpoint;
        const issued = await machineToken(endpoint, clientId, resource, privateKey, kid);
        if (!check('private_key_jwt gets a client_credentials token', issued.status === 200 && typeof issued.body?.access_token === 'string', failure(issued))) return;
        const token = issued.body.access_token;
        const claims = claimsOf(token), lifetime = claims.exp - claims.iat;
        check('the machine token names the workspace and accountable person', claims.workspace_id === workspaceId &&
            typeof claims.accountable_sub === 'string' && Boolean(claims.accountable_sub));
        check('the machine token lives at most 60 seconds', lifetime > 0 && lifetime <= 60, `${lifetime} s`, true);
        const me = await whoami(token, resource);
        check('whoami identifies the machine and its accountable person', me.status === 200 && me.facts?.kind === 'machine' &&
            me.facts.person === `service:${clientId}` && me.facts.workspace_id === workspaceId && me.facts.accountable_sub === claims.accountable_sub,
            `HTTP ${me.status}`);

        const other = new URL('/w/team-one/mcp', resource).href;
        const refused = await machineToken(endpoint, clientId, other, privateKey, kid);
        check('the machine cannot request a token for a workspace endpoint', refused.status === 400 && refused.body?.error === 'invalid_target', failure(refused));
        check('introspection reports the machine token active', (await identity.introspect(token)).active === true);
    } finally {
        console.error(`  You can disable the machine client at ${app.issuer}/account/agents.`);
    }
}
