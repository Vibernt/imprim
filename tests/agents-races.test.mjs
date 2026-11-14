import { REFRESH_GRACE_MS } from '../apps/server/src/agents/token.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, metadataId, resource, error } from './support/agents.mjs';
import { scheduled } from '../apps/server/src/services/maintenance.mjs';
import { cookieJar } from './support/world.mjs';
function changeBeforeBatch(w, match, sql) {
    const batch = w.env.DB.batch;
    w.env.DB.batch = async list => {
        // Inspect statements by instrumenting their construction, not by changing transaction semantics.
        if (match()) { w.env.DB.db.exec(sql); w.env.DB.batch = batch; }
        return batch(list);
    };
}
for (const operation of ['consent','code','refresh','device']) for (const change of ['policy','user'])
    test(`${operation} issuance fences concurrent ${change} changes at transaction time`, async t => {
        const w = await agentWorld(t);
        let run;
        if (operation === 'consent') { const flow = await w.start(); run = () => w.approve(flow); }
        if (operation === 'code') { const flow = await w.start(), approved = await w.approve(flow); const code = new URL(approved.headers.get('location')).searchParams.get('code'); run = () => w.exchange(code); }
        if (operation === 'refresh') { const { tokens } = await w.grant(); run = () => w.refresh(tokens.refresh_token); }
        if (operation === 'device') {
            const device = await (await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' })).json();
            const response = await w.call('/device?user_code=' + device.user_code, { headers: { cookie: w.cookie } });
            await w.approve({ id: new URL(response.headers.get('location')).searchParams.get('request_id'), cookie: w.cookie + '; ' + cookieJar(response) });
            w.env.DB.db.exec('UPDATE agent_devices SET next_poll=0');
            run = () => w.form('/token', { client_id: metadataId, resource, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code });
        }
        // Prewarm the signing key so the next batch is the credential transaction.
        const { signingKey } = await import('../apps/server/src/oidc/keys.mjs'); await signingKey(w.env);
        const sql = change === 'policy' ? "UPDATE clients SET agent_access='off' WHERE id='app'" : "UPDATE users SET status='blocked'";
        changeBeforeBatch(w, () => true, sql);
        const response = await run(); assert.ok(response.status >= 400, await response.text());
        assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM agent_refresh_tokens WHERE spent_at IS NOT NULL').get().n, 0);
    });

test('agent code and grant expiry; access lifetime is capped by remaining grant time', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    w.env.DB.db.prepare('UPDATE agent_grants SET expires_at=?').run(Date.now() + 60000);
    const refreshed = await (await w.refresh(tokens.refresh_token)).json(); assert.ok(refreshed.expires_in <= 60 && refreshed.expires_in > 0);
    w.env.DB.db.exec('UPDATE agent_grants SET expires_at=0');
    await error(await w.refresh(refreshed.refresh_token), 'invalid_grant');
    const flow = await w.start(), approved = await w.approve(flow), code = new URL(approved.headers.get('location')).searchParams.get('code');
    w.env.DB.db.exec('UPDATE agent_codes SET expires_at=0'); await error(await w.exchange(code), 'invalid_grant');
});

test('scheduled sweep retains short-lived device expiry tombstones and refresh reuse evidence', async t => {
    const w = await agentWorld(t), { tokens } = await w.grant();
    await w.refresh(tokens.refresh_token);
    const device = await (await w.form('/device_authorization', { client_id: metadataId, resource, scope: 'read' })).json();
    w.env.DB.db.prepare('UPDATE agent_devices SET expires_at=?').run(Date.now() - 1000);
    w.env.DB.db.prepare('UPDATE agent_refresh_tokens SET spent_at=spent_at-? WHERE spent_at IS NOT NULL').run(REFRESH_GRACE_MS + 1);
    await scheduled(w.env);
    await error(await w.form('/token', { client_id: metadataId, resource, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code }), 'expired_token');
    await error(await w.refresh(tokens.refresh_token), 'invalid_grant');
    assert.ok(w.env.DB.db.prepare('SELECT revoked_at FROM agent_grants').get().revoked_at);
});
