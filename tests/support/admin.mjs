import assert from 'node:assert/strict';
import { cookieJar } from './world.mjs';
export async function adminLogin(w) {
    const page = await w.call('/login'), browser = cookieJar(page);
    const request = await w.post('/v1/auth/magic/request', { email: 'admin@example.com', turnstile: crypto.randomUUID() }, browser);
    assert.equal(request.status, 200, await request.clone().text()); await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const response = await w.post('/v1/auth/magic/verify', { token }, browser);
    assert.equal(response.status, 303, await response.clone().text());
    const cookie = cookieJar(response), csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const post = (path, body = {}, headers = {}) => w.post('/admin/api/' + path, body, cookie, { 'x-csrf-token': csrf, ...headers });
    const get = path => w.call('/admin/api/' + path, { headers: { cookie } });
    return { cookie, csrf, post, get };
}
export const clientConfig = { id: 'touchstone', redirect_uris: ['https://touchstone.example/callback'], post_logout_uris: ['https://touchstone.example/bye'],
    backchannel_uri: 'https://touchstone.example/backchannel', branding: { name: 'Touchstone' } };
