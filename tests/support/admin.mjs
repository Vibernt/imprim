import assert from 'node:assert/strict';
import { cookieJar } from './world.mjs';
import { totpAt, fromBase32, currentStep } from '../../apps/server/src/auth/totp.mjs';
// Enrols an authenticator the way a person would (start, scan, confirm), which also satisfies this session's
// second factor. Returns a function that produces a current code for later challenges.
export async function enrolMfa(w, cookie, csrf) {
    const form = body => w.call('/account/mfa', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: w.env.ISSUER, cookie }, body: new URLSearchParams({ csrf, ...body }) });
    const start = await (await form({ action: 'start' })).text();
    const secret = start.match(/id="totp-secret">([A-Z2-7 ]+)</)[1].replaceAll(' ', '');
    const factor = start.match(/name="factor_id" value="([^"]+)"/)[1];
    const code = async (offset = 0) => totpAt(fromBase32(secret), currentStep() + offset);
    const confirmed = await form({ action: 'confirm', factor_id: factor, name: 'Test phone', code: await code() });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    return { secret, code, recovery: [...(await confirmed.text()).matchAll(/<li><code>([A-Z2-7-]+)<\/code><\/li>/g)].map(m => m[1]) };
}
export async function adminLogin(w) {
    const page = await w.call('/login'), browser = cookieJar(page);
    const request = await w.post('/v1/auth/magic/request', { email: 'admin@example.com', turnstile: crypto.randomUUID() }, browser);
    assert.equal(request.status, 200, await request.clone().text()); await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const response = await w.post('/v1/auth/magic/verify', { token }, browser);
    assert.equal(response.status, 303, await response.clone().text());
    const cookie = cookieJar(response), csrf = cookie.match(/__Host-vi_csrf=([^;]+)/)[1];
    const mfa = await enrolMfa(w, cookie, csrf);
    const post = (path, body = {}, headers = {}) => w.post('/admin/api/' + path, body, cookie, { 'x-csrf-token': csrf, ...headers });
    const get = path => w.call('/admin/api/' + path, { headers: { cookie } });
    return { cookie, csrf, post, get, mfa };
}
export const clientConfig = { id: 'touchstone', redirect_uris: ['https://touchstone.example/callback'], post_logout_uris: ['https://touchstone.example/bye'],
    backchannel_uri: 'https://touchstone.example/backchannel', branding: { name: 'Touchstone' } };
