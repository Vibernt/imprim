import assert from 'node:assert/strict';
import { issueSession } from '../../apps/server/src/auth/session.mjs';
import { ensureUser } from '../../apps/server/src/services/admission.mjs';
import { cookieJar, world } from './world.mjs';

export const joinPath = '/workspace-join';
export const jarOf = (...parts) => parts.filter(Boolean).join('; ');
export const csrfOf = cookie => cookie.match(/__Host-vi_csrf=([^;]+)/)[1];

export function configureJoin(db, from = 'app', to = 'other') {
    db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default'");
    const client = db.prepare(`UPDATE clients SET workspaces='shared',product=?,join_workspaces=?,backchannel_uri='https://app.example/events' WHERE id=?`);
    client.run('notes', 'off', from);
    client.run('tasks', 'on', to);
}

export function addTeam(db, id, userId, { name = id, product = 'notes', kind = 'team', status = 'active', role = 'owner' } = {}) {
    db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,status,personal_owner,created) VALUES(?,'default',?,?,?,?,0)")
        .run(id, kind, name, status, kind === 'personal' ? userId : null);
    db.prepare('INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,?,0)').run(id, product);
    db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES(?,?,?,0,0)').run(id, userId, role);
}

export async function joinWorld(t) {
    const w = await world(t, 'invited'), db = w.env.DB.db;
    configureJoin(db);
    async function person(email = 'owner@example.com') {
        const user = await ensureUser(w.env, email);
        const { session, cookies } = await issueSession(w.env, user, 'email');
        const cookie = jarOf(...cookies.map(value => value.split(';')[0]));
        return { user, session, cookie, csrf: csrfOf(cookie) };
    }
    const start = (person, query = {}) => w.authorize({ client_id: 'other', ...query }, person.cookie);
    async function offer(person, query) {
        const res = await start(person, query);
        assert.equal(res.status, 303, await res.clone().text());
        const url = new URL(res.headers.get('location'));
        assert.equal(url.origin, w.env.ISSUER);
        assert.equal(url.pathname, joinPath);
        const id = url.searchParams.get('request_id'), browser = cookieJar(res), cookie = jarOf(person.cookie, browser);
        return { id, browser, cookie, csrf: person.csrf, path: url.pathname + url.search };
    }
    const form = (path, body, cookie, headers = {}) => w.call(path, { method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie, ...headers
    }, body: new URLSearchParams(body) });
    const answer = (flow, body = {}, headers = {}) => form(joinPath,
        { action: 'join', request_id: flow.id, workspace_id: 'team', csrf: flow.csrf, ...body }, flow.cookie, headers);
    const productCount = () => db.prepare("SELECT count(*) AS n FROM workspace_products WHERE product='tasks'").get().n;
    return { ...w, db, person, start, offer, form, answer, productCount };
}
