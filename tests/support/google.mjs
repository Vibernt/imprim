import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { begin, cookieJar } from './world.mjs';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const googleJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'google-test', alg: 'RS256', use: 'sig' };
const privateKey = await crypto.subtle.importKey('jwk', pair.privateKey.export({ format: 'jwk' }), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
export async function googleJwt(claims, header = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid: googleJwk.kid, ...header })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
}
export async function googleStart(w) {
    const flow = await begin(w);
    const response = await w.call(`/v1/auth/google/start?request_id=${flow.request_id}`, { headers: { cookie: flow.cookie } });
    assert.equal(response.status, 303);
    return { ...flow, response, url: new URL(response.headers.get('location')), cookie: flow.cookie + '; ' + cookieJar(response) };
}
export const googleCallback = (w, flow, changes = {}, cookie = flow.cookie) => w.call('/login/google/callback?' + new URLSearchParams({ code: '4/google-code', state: flow.url.searchParams.get('state'), ...changes }), { headers: { cookie } });
export function fakeGoogle(t, w, overrides = {}, header = {}) {
    const calls = [], config = { overrides, header, nonce: null, jwks: { keys: [googleJwk] }, cacheControl: 'public, max-age=3600' };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        assert.equal(w.env.DB.db.isTransaction, false, 'provider I/O must be outside database transactions');
        assert.equal(options.redirect, 'manual');
        if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(config.jwks, { headers: { 'cache-control': config.cacheControl } });
        assert.equal(url, 'https://oauth2.googleapis.com/token');
        const claims = { iss: 'https://accounts.google.com', aud: w.env.GOOGLE_CLIENT_ID, sub: 'google-42', email: 'person@example.com', email_verified: true,
            exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), nonce: config.nonce, hd: 'example.com', ...config.overrides };
        return Response.json({ id_token: await googleJwt(claims, config.header), access_token: 'unused' });
    });
    return { calls, config, async start() { const flow = await googleStart(w); config.nonce = flow.url.searchParams.get('nonce'); return flow; } };
}
