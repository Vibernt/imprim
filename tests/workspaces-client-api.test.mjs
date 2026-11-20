import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, IdentityError } from '../packages/imprim-client/index.mjs';

const issuer = 'https://id.example.com', id = 'imported-id', path = '/v1/workspaces/imported-id';
const actor = { actorToken: 'id-token' }, wireActor = { actor_token: actor.actorToken };
const resource = 'https://app.example/mcp', sub = 'old/sub?#', member = path + '/members/old%2Fsub%3F%23';
const email = 'owner@example.com', role = 'owner';
const clientOptions = { issuer, clientId: 'app:id', clientSecret: 'key +:' };
const requests = [
    ['memberships', [sub], 'GET', '/v1/memberships?sub=old%2Fsub%3F%23'],
    ['joinableWorkspaces', [actor], 'POST', '/v1/workspaces/joinable', wireActor],
    ['workspace', [id], 'GET', path],
    ['workspaceMembers', [id], 'GET', path + '/members'],
    ['workspaceMembers', [id, { limit: 20, cursor: 'a+b=' }], 'GET', path + '/members?limit=20&cursor=a%2Bb%3D'],
    ['workspaceMembers', [id, { cursor: null }], 'GET', path + '/members'],
    ['createWorkspace', [{ kind: 'team', name: 'Team', products: ['notes'], firstOwnerEmail: email, ...actor }],
        'POST', '/v1/workspaces', { name: 'Team', products: ['notes'], first_owner_email: email, ...wireActor }],
    ['createWorkspace', [{ kind: 'personal', name: 'Personal', ...actor }],
        'POST', '/v1/workspaces', { kind: 'personal', name: 'Personal', ...wireActor }],
    ['renameWorkspace', [id, { name: 'Renamed', actor_token: 'ignore', ...actor }], 'PATCH', path, { name: 'Renamed', ...wireActor }],
    ['setWorkspaceProducts', [id, { add: ['notes'], remove: ['tasks'], ...actor }],
        'POST', path + '/products', { add: ['notes'], remove: ['tasks'], ...wireActor }],
    ['setWorkspaceProducts', [id, { add: ['notes'], ...actor }],
        'POST', path + '/products', { add: ['notes'], remove: [], ...wireActor }],
    ['setWorkspaceProducts', [id, { remove: ['notes'], ...actor }],
        'POST', path + '/products', { add: [], remove: ['notes'], ...wireActor }],
    ['inviteToWorkspace', [id, { email, role, ...actor }], 'POST', path + '/invitations', { email, role, ...wireActor }],
    ['workspaceInvitations', [id], 'GET', path + '/invitations'],
    ['revokeWorkspaceInvitation', [id, 'a/b', actor], 'DELETE', path + '/invitations/a%2Fb', wireActor],
    ['setMemberRole', [id, sub, { role, ...actor }], 'POST', member, { role, ...wireActor }],
    ['removeMember', [id, sub, actor], 'DELETE', member, wireActor],
    ['closeWorkspace', [id, actor], 'POST', path + '/close', wireActor],
    ['closeWorkspace', [id, { confirm: 'Team', ...actor }], 'POST', path + '/close', { confirm: 'Team', ...wireActor }],
    ['closeWorkspace', [id, { confirm: 'Team', releaseOwnHold: true, ...actor }], 'POST', path + '/close', { confirm: 'Team', release_own_hold: true, ...wireActor }],
    ['closeWorkspace', [id, { releaseOwnHold: false, ...actor }], 'POST', path + '/close', wireActor],
    ['holdWorkspace', [id, 'Balance due'], 'PUT', path + '/holds', { reason: 'Balance due' }],
    ['releaseWorkspace', [id, 'Settled'], 'DELETE', path + '/holds', { reason: 'Settled' }],
    ['releaseWorkspace', [id], 'DELETE', path + '/holds', {}],
    ['registerWorkspaceResource', [id, resource], 'PUT', path + '/resources', { resource }],
    ['unregisterWorkspaceResource', [id, resource], 'DELETE', path + '/resources', { resource }]
];

for (const [method, args, verb, target, body] of requests) test(`workspace client ${method} sends ${verb} ${target}`, async () => {
    const responses = { inviteToWorkspace: { invitation_id: 'invitation', expires_at: 123 }, joinableWorkspaces: { workspaces: [] } };
    const response = responses[method] ?? { result: true };
    const calls = [];
    const client = createClient({ ...clientOptions, fetch: async (url, init) => {
        calls.push([url, init]);
        return Response.json(response, { status: method === 'inviteToWorkspace' ? 201 : 200 });
    } });
    assert.deepEqual(await client[method](...args), response);
    const headers = { authorization: 'Basic ' + btoa('app%3Aid:key%20%2B%3A') };
    const expected = { method: verb, redirect: 'manual', headers };
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        expected.body = JSON.stringify(body);
    }
    assert.deepEqual(calls, [[issuer + target, expected]]);
});

test('workspace client refuses missing credentials, missing actor and unsafe or invalid parameters before transport', async () => {
    const fetch = () => assert.fail('Unexpected transport call');
    const client = createClient({ ...clientOptions, fetch });
    const publicClient = createClient({ issuer, clientId: 'app', fetch });
    await assert.rejects(publicClient.workspace(id), { code: 'configuration' });
    await assert.rejects(publicClient.joinableWorkspaces(actor), { code: 'configuration' });
    for (const [method, args] of requests.filter(([, , , , body]) => body?.actor_token)) {
        const missing = [...args];
        missing[missing.length - 1] = { ...missing.at(-1), actorToken: undefined, actor_token: 'not-an-actor-option' };
        await assert.rejects(client[method](...missing), { code: 'configuration' });
    }
    for (const bad of ['.', '..', '', '\ud800']) await assert.rejects(client.workspace(bad), { code: 'configuration' });
    await assert.rejects(client.memberships(''), { code: 'configuration' });
    await assert.rejects(client.workspaceMembers(id, { limit: 201 }), { code: 'configuration' });
    await assert.rejects(client.workspaceMembers(id, { cursor: 2 }), { code: 'configuration' });
    await assert.rejects(client.closeWorkspace(id, { ...actor, confirm: 2 }), { code: 'configuration' });
    await assert.rejects(client.createWorkspace({ kind: 'other', ...actor }), { code: 'configuration' });
});

test('workspace client uses the existing HTTP, malformed JSON and network error mapping', async () => {
    const client = createClient({ ...clientOptions, fetch: async () =>
        Response.json({ error: 'workspace_held', error_description: 'Balance due' }, { status: 409 }) });
    await assert.rejects(client.closeWorkspace(id, actor), error => error instanceof IdentityError &&
        error.code === 'workspace_held' && error.description === 'Balance due' && /HTTP 409/.test(error.message));
    const untrusted = createClient({ ...clientOptions, fetch: async () =>
        Response.json({ error: '<script>', error_description: 'x'.repeat(550) }, { status: 500 }) });
    await assert.rejects(untrusted.workspace(id), { code: 'workspaces', description: 'x'.repeat(500) });
    const nonJson = createClient({ ...clientOptions, fetch: async () => new Response('bad', { status: 502 }) });
    await assert.rejects(nonJson.workspace(id), { code: 'workspaces' });
    const offline = createClient({ ...clientOptions, fetch: async () => { throw new Error('offline'); } });
    await assert.rejects(offline.workspace(id), { code: 'network' });
});
