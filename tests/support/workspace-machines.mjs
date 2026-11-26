import assert from 'node:assert/strict';
import { basic, world } from './world.mjs';
import { accountSession, csrf } from './account-api.mjs';
import { response } from './workspaces.mjs';
import { ASSERTION, assertion, keyPair } from './machine-keys.mjs';
import { signIdToken } from '../../apps/server/src/oidc/jwt.mjs';

export const path = '/v1/workspaces/ws_test/machine-clients';
export const resource = 'https://app.example/w/team/mcp';
export const choice = 'https://app.example/mcp';
export const form = (w, target, values, headers = {}) => w.call(target, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, ...headers },
    body: new URLSearchParams(values) });
export const approvalPath = id => '/machine-client?request_id=' + id;

export function seedMachineWorkspace(db, userId) {
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default';
        UPDATE clients SET workspaces='shared',product='notes',agent_access='on',
           initiate_login_uri='https://app.example/sign-in',branding='{"name":"Example App"}',
           agent_scope_catalogue='{"read":"Read workspace","write":"Edit workspace"}',
           agent_resource_prefixes='["https://app.example/"]',agent_workspace_resources='["https://app.example/mcp"]' WHERE id='app';
        INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('ws_test','default','team','Editorial team',0);
        INSERT INTO workspace_products(workspace_id,product,created) VALUES('ws_test','notes',0);
        INSERT INTO workspace_resources(resource,workspace_id,client_id,created,name)
            VALUES('${resource}','ws_test','app',0,'Editorial tools');`);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('ws_test',?,'owner',0,0)").run(userId);
}

export async function seededRequest(w, { body, key, resources = [resource, choice] } = {}) {
    const pair = key ?? await keyPair();
    const payload = { name: 'Editorial bot', jwks: { keys: [pair.jwk] }, scopes: ['read'], resources, ...body };
    const receipt = await response(await w.post(path, payload, '', { authorization: basic() }), 201);
    return { ...receipt, pair };
}

export async function machineWorld(t) {
    const w = await world(t), db = w.env.DB.db;
    // Issue the session after importing a stable non-UUID principal.
    db.prepare("INSERT INTO users(id,email,email_verified,created) VALUES(?, ?, 1, 0)").run('legacy:editor', 'owner@app.example');
    const owner = await accountSession(w, 'owner@app.example');
    seedMachineWorkspace(db, owner.user.id);
    db.exec(`INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('ws_other','default','team','Other',0);
        INSERT INTO workspace_products(workspace_id,product,created) VALUES('ws_other','notes',0);`);
    const pair = await keyPair();
    const payload = { name: 'Editorial bot', jwks: { keys: [pair.jwk] }, scopes: ['read'], resources: [resource, choice] };
    const api = (method, suffix = '', body, auth = basic()) => w.call(path + suffix, {
        method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const submit = (id, person = owner, { decision = 'approve', fields = {}, headers = {} } = {}) =>
        form(w, '/machine-client', { request_id: id, csrf: csrf(person.cookie), decision, ...fields }, { cookie: person.cookie, ...headers });
    const view = (id, person = owner) => w.call(approvalPath(id), { headers: { cookie: person.cookie, accept: 'text/html' } });
    const status = async id => response(await api('GET', '/requests/' + id));
    const actor = async (person = owner, app = 'app') => signIdToken(w.env, person.session, { client_id: app, scope: 'openid' });
    const token = async (id, target = resource, headers = {}) => form(w, '/token', { grant_type: 'client_credentials',
        client_id: id, resource: target, client_assertion_type: ASSERTION, client_assertion: await assertion(pair, id) }, headers);
    const introspect = async (value, app = 'app') => response(await form(w, '/introspect', { token: value }, { authorization: basic(app) }));
    const create = (body = {}) => seededRequest(w, { key: pair, body });
    const approve = async (person = owner) => {
        const { request_id } = await create();
        const result = await submit(request_id, person);
        assert.equal(result.status, 200, await result.clone().text());
        const { service_client_id } = await status(request_id);
        assert.match(service_client_id, /^ws-[a-f0-9]{20}$/);
        return service_client_id;
    };
    const addPerson = async role => {
        const person = await accountSession(w, `${role}@app.example`);
        db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES('ws_test',?,?,0,0)").run(person.user.id, role);
        return person;
    };
    const audit = event => db.prepare('SELECT actor,target,detail FROM audit WHERE event=? ORDER BY rowid').all(event);
    const fillMachines = n => db.prepare(`INSERT INTO service_clients(id,realm_id,app_id,name,owner_email,jwks,scopes,resource_prefixes,
        source,workspace_id,accountable_user_id,expires_at,created,updated)
        SELECT 'ws-'||printf('%020x',value),'default','app','Other bot','owner@app.example',?,'["read"]',?,
            'workspace','ws_test',?,?,0,0 FROM json_each(?)`)
        .run(JSON.stringify(payload.jwks), JSON.stringify(payload.resources), owner.user.id, Date.now() + 3600000, JSON.stringify(Array.from({length: n}, (_, i) => i)));
    return { ...w, db, pair, payload, owner, api, submit, view, status, actor, token, introspect, create, approve, addPerson, audit, fillMachines };
}
