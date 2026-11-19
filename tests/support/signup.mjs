import assert from 'node:assert/strict';
import { begin, world } from './world.mjs';

export const requestPath = '/v1/auth/magic/request';
export const verifyPath = '/v1/auth/magic/verify';
export const person = 'person@example.com';

export async function signupWorld(t, { realmSignup = 'open', realmWorkspaces = 'on', appSignup = 'on', workspaces = 'shared', botCheck = false } = {}) {
    const w = await world(t, 'invited'), db = w.env.DB.db;
    db.prepare("UPDATE realms SET config=json_set(config,'$.signup',?,'$.workspaces',?)").run(realmSignup, realmWorkspaces);
    if (!botCheck) db.exec("UPDATE realms SET config=json_remove(config,'$.turnstile')");
    db.prepare(`UPDATE clients SET workspaces=?,product='notes',self_signup=?,backchannel_uri=?,branding='{"name":"Notes"}'
        WHERE id='app'`).run(workspaces, appSignup, 'https://app.example/events');
    db.exec(`UPDATE clients SET workspaces='shared',product='notes',self_signup='on',
        backchannel_uri='https://other.example/events' WHERE id='other'`);
    return { ...w, db };
}

export function ask(w, flow, email = person, fields = {}, headers = {}) {
    return w.post(requestPath, { request_id: flow.request_id, email, purpose: 'signup', ...fields }, flow.cookie, headers);
}

export async function mint(w, { email = person, client = 'app', fields = {}, authorization = {} } = {}) {
    const flow = await begin(w, '', { client_id: client, ...authorization });
    const count = w.mails.length, response = await ask(w, flow, email, fields);
    assert.equal(response.status, 202, await response.clone().text());
    assert.deepEqual(await response.json(), { accepted: true });
    await w.drain();
    assert.equal(w.mails.length, count + 1);
    const mail = w.mails.at(-1), token = mail.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    return { ...flow, token, mail };
}

export const verify = (w, { token, cookie }, fields = {}, headers = {}) => w.post(verifyPath, { token, ...fields }, cookie, headers);
export async function refused(response, status, error) {
    assert.equal(response.status, status, await response.clone().text());
    assert.equal((await response.json()).error, error);
}

export function invite(db, email = person, product = 'notes') {
    db.exec("INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES('invited-team','default','team','Existing team',0)");
    db.prepare("INSERT INTO workspace_products(workspace_id,product,created) VALUES('invited-team',?,0)").run(product);
    db.prepare(`INSERT INTO workspace_invitations(id,workspace_id,email,role,created,expires_at)
        VALUES('invite','invited-team',?,'member',0,?)`).run(email, Date.now() + 60000);
}

export const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
