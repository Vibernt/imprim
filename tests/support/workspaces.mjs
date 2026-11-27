import assert from 'node:assert/strict';
import { ensureUser } from '../../apps/server/src/services/admission.mjs';
import { issueSession } from '../../apps/server/src/auth/session.mjs';
import { signIdToken } from '../../apps/server/src/oidc/jwt.mjs';
import { basic, world } from './world.mjs';

export const root = '/v1/workspaces';

export async function setup(t, { enabled = true } = {}) {
    const w = await world(t);
    const db = w.env.DB.db;
    db.prepare("UPDATE realms SET config=json_set(config,'$.workspaces',?) WHERE id='default'").run(enabled ? 'on' : 'off');
    db.prepare(`UPDATE clients SET workspaces='shared',product='notes',personal_workspaces='on',workspace_admin='on',
        initiate_login_uri='https://app.example.com/start',agent_resource_prefixes='["https://app.example/w/"]',backchannel_uri='https://app.example/events' WHERE id='app'`).run();
    db.prepare("UPDATE clients SET workspaces='shared',product='tasks',initiate_login_uri='https://tasks.example.com/start',backchannel_uri='https://other.example/events' WHERE id='other'").run();
    function api(method, path, body, auth = basic()) {
        const headers = { accept: 'application/json', ...(auth ? { authorization: auth } : {}) };
        if (body !== undefined) headers['content-type'] = 'application/json';
        return w.call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    }
    async function actor(email, client = 'app') {
        const user = await ensureUser(w.env, email);
        const { session } = await issueSession(w.env, user, 'email');
        const actor_token = await signIdToken(w.env, session, { client_id: client, scope: 'openid' });
        return { id: user.id, email, session, actor_token };
    }
    async function team(owner, body = {}, auth = basic()) {
        return response(await api('POST', root, { name: 'Team', products: ['notes'], first_owner_email: owner.email,
            actor_token: owner.actor_token, ...body }, auth), 201);
    }
    async function addTasks(owner, workspaceId) {
        db.prepare("UPDATE clients SET workspace_admin='on' WHERE id='other'").run();
        const { actor_token } = await actor(owner.email, 'other');
        return response(await api('POST', root + '/' + workspaceId + '/products', { add: ['tasks'], remove: [], actor_token }, basic('other')));
    }
    const addMember = (id, actor, role, created = Date.now()) => db.prepare(
        'INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES(?,?,?,?,?)'
    ).run(id, actor.id, role, created, created);
    return { ...w, db, api, actor, team, addTasks, addMember };
}

export async function response(resp, status = 200) {
    const result = await resp.json();
    assert.equal(resp.status, status, JSON.stringify(result));
    return result;
}
