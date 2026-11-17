import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../packages/imprim-client/index.mjs';
import { verifyBackchannel as verifyVendored } from '../dist/imprim-client.mjs';
import { signAgentJwt } from '../apps/server/src/agents/grants.mjs';
import { world } from './support/world.mjs';

const form = token => new URLSearchParams({ workspace_token: token });
async function fixture(t) {
    const w = await world(t);
    const options = { issuer: w.env.ISSUER, clientId: 'app', fetch: url => w.call(new URL(url).pathname) };
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: options.issuer, aud: 'app', jti: 'outbox-id', sub: 'imported-sub',
        iat: now, exp: now + 300, toe: now - 1 };
    const data = { workspace_id: 'imported-id', version: 2 };
    const events = (name, payload = data) => ({ [`${options.issuer}/events/${name}`]: payload });
    const sign = (patch = {}, typ = 'secevent+jwt') =>
        signAgentJwt(w.env, { ...claims, events: events('workspace-member-removed'), ...patch }, typ);
    return { options, client: createClient(options), claims, data, events, sign };
}

test('workspace client verifies each signed workspace event and the vendored dispatcher', async t => {
    const x = await fixture(t);
    for (const [event, fields, sub] of [
        ['workspace-member-added', { role: 'owner' }, x.claims.sub],
        ['workspace-member-removed', {}, x.claims.sub],
        ['workspace-role-changed', { role: 'viewer' }, x.claims.sub],
        ['workspace-updated', { name: 'Renamed' }],
        ['workspace-products-changed', { products: ['notes'] }],
        ['workspace-closed', {}]
    ]) {
        const payload = { ...x.data, ...fields };
        const token = await x.sign({ sub, events: x.events(event, payload) });
        assert.deepEqual(await x.client.verifyBackchannel(form(token)), {
            kind: 'workspace', claims: { event, workspaceId: 'imported-id', sub, version: 2, payload, jti: 'outbox-id' }
        });
    }
    assert.equal((await verifyVendored(form(await x.sign()), x.options)).kind, 'workspace');
});

test('workspace client refuses forged, misaddressed, expired or malformed events', async t => {
    const x = await fixture(t);
    for (const patch of [
        { aud: 'other' }, { aud: ['app'] }, { iss: 'https://other.example' }, { iat: 1, exp: 301, toe: 1 },
        { iat: x.claims.iat + 120, exp: x.claims.exp + 120 }, { exp: x.claims.iat + 901 },
        { toe: undefined }, { nonce: 'wrong-kind' }, { jti: '' }, { sub: undefined },
        { events: x.events('workspace-unknown') }, { events: { 'https://other.example/events/workspace-member-removed': x.data } },
        { events: { ...x.events('workspace-member-removed'), ...x.events('workspace-closed') } },
        { events: x.events('workspace-member-removed', { ...x.data, version: 0 }) },
        { events: x.events('workspace-member-removed', { ...x.data, workspace_id: '../bad' }) },
        { events: x.events('workspace-role-changed', { ...x.data, role: 'root' }) },
        { events: x.events('workspace-updated') },
        { sub: undefined, events: x.events('workspace-products-changed', { ...x.data, products: 'notes' }) }
    ]) await assert.rejects(x.client.verifyBackchannel(form(await x.sign(patch))), { code: 'invalid_token' });
    await assert.rejects(x.client.verifyBackchannel(form(await x.sign({}, 'JWT'))), { code: 'invalid_token' });
    const parts = (await x.sign()).split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await assert.rejects(x.client.verifyBackchannel(form(parts.join('.'))), { code: 'invalid_token' });
});

test('workspace token dispatch rejects duplicates, mixed fields, file uploads and swapped token kinds', async t => {
    const x = await fixture(t), token = await x.sign();
    const duplicate = form(token);
    duplicate.append('workspace_token', token);
    const file = new FormData();
    file.set('workspace_token', new Blob([token]));
    for (const bad of [duplicate, file, new URLSearchParams({ workspace_token: token, event_token: token })])
        await assert.rejects(x.client.verifyBackchannel(bad), { code: 'invalid_response' });
    await assert.rejects(x.client.verifyBackchannel(new URLSearchParams({ event_token: token })), { code: 'invalid_token' });
    await assert.rejects(x.client.verifyBackchannel(form(await x.sign({ events: x.events('user-blocked', {}) }))), { code: 'invalid_token' });
});
