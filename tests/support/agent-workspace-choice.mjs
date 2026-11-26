import assert from 'node:assert/strict';
import { agentWorld } from './agents.mjs';
import { basic } from './world.mjs';
import { signIdToken } from '../../apps/server/src/oidc/jwt.mjs';

export const resource = 'https://app.example/mcp';
export const target = 'https://other.example/mcp';
export const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';
export const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token';
export const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
export const consentPath = flow => '/agent/consent?request_id=' + encodeURIComponent(flow.id);

export async function setup(t) {
    const w = await agentWorld(t), db = w.env.DB.db;
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
        UPDATE clients SET workspaces='shared',product='notes',workspace_admin='on',backchannel_uri='https://app.example/events',
           initiate_login_uri='https://app.example/sign-in',
           agent_resource_prefixes='["https://app.example/"]',agent_workspace_resources='["https://app.example/mcp"]' WHERE id='app';
        UPDATE clients SET agent_resource_prefixes='["https://other.example/"]',agent_scope_catalogue='{"read":"Read"}',
           token_exchange_from='{"app":["read"]}' WHERE id='other';
        INSERT INTO realms(id,issuer,display_name,created) VALUES('foreign','https://foreign.example','Foreign',0);`);
    function addWorkspace(id, { name = id, product = 'notes', role = 'viewer', kind = 'team', status = 'active', realm = 'default' } = {}) {
        db.prepare('INSERT INTO workspaces(id,realm_id,kind,name,status,personal_owner,created) VALUES(?,?,?,?,?,?,0)')
            .run(id, realm, kind, name, status, kind === 'personal' ? w.user.id : null);
        if (product) db.prepare('INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,?,0)').run(id, product);
        if (role) db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES(?,?,?,0,0)').run(id, w.user.id, role);
    }
    const start = async (options = {}) => {
        const flow = await w.start({ resource, ...options });
        assert.equal(flow.response.status, 303, await flow.response.clone().text());
        assert.ok(flow.id);
        return flow;
    };
    const getConsent = (flow, headers = {}) => w.call(consentPath(flow), { headers: { cookie: flow.cookie, ...headers } });
    const approve = (flow, workspaceId, { replace = '', scope = ['read'], decision = 'approve', headers = {} } = {}) =>
        w.form('/agent/consent', [['request_id', flow.id], ['csrf', w.csrf], ['decision', decision], ['replace', replace],
            ...(workspaceId === undefined ? [] : [['workspace_id', workspaceId]]), ...scope.map(value => ['scope', value])], flow.cookie, headers);
    const grant = async (workspaceId, { options = {}, ...selection } = {}) => {
        const flow = await start(options);
        const consent = await approve(flow, workspaceId, selection);
        assert.equal(consent.status, 303, await consent.clone().text());
        const code = new URL(consent.headers.get('location')).searchParams.get('code');
        assert.ok(code);
        const response = await w.exchange(code, { resource: options.resource ?? resource });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const introspect = async (token, app = 'app') => {
        const response = await w.form('/introspect', { token }, '', { authorization: basic(app) });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const mutation = async (method, id, path, body = {}) => {
        const actor_token = await signIdToken(w.env, w.signed.session, { client_id: 'app', scope: 'openid' });
        const response = await w.call(`/v1/workspaces/${id}/${path}`, { method,
            headers: { authorization: basic(), 'content-type': 'application/json' }, body: JSON.stringify({ ...body, actor_token }) });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    return { ...w, db, addWorkspace, start, getConsent, approve, grant, introspect, mutation };
}
