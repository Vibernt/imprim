import assert from 'node:assert/strict';
import { begin, cookieJar } from './world.mjs';
import { count, person } from './signup.mjs';

export const providerId = { google: 'google-42', github: '42' };
export const gmail = 'person@gmail.com';

export function githubProfile(t, w, { email = person, beforeProfile } = {}) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(w.db.isTransaction, false);
        calls.push(url);
        switch (url) {
        case 'https://github.com/login/oauth/access_token': return Response.json({ access_token: 'github-test-token' });
        case 'https://api.github.com/user': return Response.json({ id: 42, login: 'person' });
        case 'https://api.github.com/user/emails?per_page=100':
            beforeProfile?.();
            return Response.json([{ email, primary: true, verified: true }]);
        default: throw new Error('Unexpected fetch to ' + url);
        }
    });
    return calls;
}

export function postSignup(w, method, { request_id, cookie }, fields, headers) {
    return w.call(`/v1/auth/${method}/signup`, { method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie, ...headers
    }, body: new URLSearchParams({ request_id, ...fields }) });
}

export async function startProvider(w, method, { signup = true, flow, fields, google } = {}) {
    flow ??= await begin(w);
    const response = signup ? await postSignup(w, method, flow, fields)
        : await w.call(`/v1/auth/${method}/start?` + new URLSearchParams({ request_id: flow.request_id, purpose: 'signup' }), { headers: { cookie: flow.cookie } });
    assert.equal(response.status, 303, await response.clone().text());
    const url = new URL(response.headers.get('location'));
    if (google) google.config.nonce = url.searchParams.get('nonce');
    return { ...flow, response, method, url, cookie: [flow.cookie, cookieJar(response)].join('; ') };
}

export function providerCallback(w, flow, { cookie = flow.cookie, accept, query } = {}) {
    const path = flow.method === 'google' ? '/login/google/callback' : '/auth/github/callback';
    return w.call(path + '?' + new URLSearchParams({ state: flow.url.searchParams.get('state'), code: 'test-code', ...query }),
        { headers: { cookie, ...(accept ? { accept } : {}) } });
}

export const effects = ['users', 'user_identities', 'workspaces', 'workspace_members', 'workspace_products',
    'client_admissions', 'workspace_event_outbox', 'signup_requests', 'magic_links', 'sessions', 'codes'];
export const effectCounts = db => Object.fromEntries(effects.map(table => [table, count(db, table)]));
export const unchanged = (db, before = Object.fromEntries(effects.map(table => [table, 0]))) => assert.deepEqual(effectCounts(db), before);
export const locationOf = response => new URL(response.headers.get('location'));
export const linkToken = w => w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
