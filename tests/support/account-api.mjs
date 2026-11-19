import assert from 'node:assert/strict';
import { issueSession } from '../../apps/server/src/auth/session.mjs';
import { ensureUser } from '../../apps/server/src/services/admission.mjs';

export async function accountSession(w, email = 'person@example.com', method = 'email') {
    const user = await ensureUser(w.env, email);
    const signed = await issueSession(w.env, user, method);
    return { user, session: signed.session, cookie: signed.cookies.map(value => value.split(';')[0]).join('; ') };
}

export const csrf = cookie => cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
export const read = (w, path, cookie = '') => w.call(`/v1/account/${path}`, { headers: { cookie, accept: 'application/json' } });
export const change = (w, path, body, cookie, headers = {}) => w.post(`/v1/account/${path}`, body, cookie, { 'x-csrf-token': csrf(cookie), ...headers });

export async function problem(response, status, error) {
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const body = await response.json();
    assert.equal(body.error, error);
    assert.ok(body.error_description);
}

export async function checkBoundaries(w, cookie, reads, mutations) {
    for (const path of reads) await problem(await read(w, path), 401, 'login_required');
    for (const path of mutations) {
        const api = `/v1/account/${path}`;
        await problem(await w.post(api, {}), 401, 'login_required');
        await problem(await w.post(api, { csrf: csrf(cookie) }, cookie), 403, 'csrf');
        await problem(await change(w, path, {}, cookie, { 'x-csrf-token': 'wrong' }), 403, 'csrf');
        await problem(await change(w, path, {}, cookie, { origin: 'https://elsewhere.example' }), 403, 'origin');
        await problem(await change(w, path, {}, cookie, { origin: '' }), 403, 'origin');
        await problem(await change(w, path, [], cookie), 400, 'invalid_request');
    }
}
