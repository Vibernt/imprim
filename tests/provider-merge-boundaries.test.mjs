import test from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/world.mjs';
import { providerIdentity } from '../apps/server/src/auth/provider-identity.mjs';
import { getClient } from '../apps/server/src/oidc/clients.mjs';

for (const provider of ['github','google']) for (const kind of ['deleted email owner','blocked email owner','other merge target','mixed-case live email owner','mixed-case linked admin'])
    test(`${provider} linked identity handles ${kind} without reassignment`, async t => {
        const w = await world(t);
        w.env.DB.db.exec("INSERT INTO users(id,email,created) VALUES('linked','linked@example.com',0),('matching','provider@example.com',0),('other','other@example.com',0)");
        w.env.DB.db.prepare('INSERT INTO user_identities(provider,provider_id,user_id,login,created) VALUES(?,?,?,?,?)').run(provider,'42','linked',null,0);
        if (kind === 'deleted email owner') w.env.DB.db.exec("UPDATE users SET status='deleted' WHERE id='matching'");
        if (kind === 'blocked email owner') w.env.DB.db.exec("UPDATE users SET status='blocked' WHERE id='matching'");
        if (kind === 'other merge target') w.env.DB.db.exec("UPDATE users SET status='deleted',merged_into='other' WHERE id='matching'");
        if (kind === 'mixed-case live email owner') w.env.DB.db.exec("UPDATE users SET email='Provider@Example.COM' WHERE id='matching'");
        if (kind === 'mixed-case linked admin') w.env.DB.db.exec("UPDATE users SET email='Admin@Example.COM' WHERE id='linked'; DELETE FROM users WHERE id='matching'");
        const attempt = providerIdentity(w.env, await getClient(w.env,'app'), provider, { providerId: '42', email: 'provider@example.com' });
        if (kind === 'deleted email owner') assert.equal((await attempt).id, 'linked');
        else await assert.rejects(attempt, error => error.code === 'access_denied');
        assert.equal(w.env.DB.db.prepare('SELECT user_id FROM user_identities').get().user_id, 'linked');
    });
