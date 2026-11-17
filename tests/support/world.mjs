import { d1Database } from './sqlite.mjs';
import { realmEnv } from '../../apps/server/src/realms/realm.mjs';
import worker from '../../apps/server/src/worker.mjs';
import { sha256, challengeOf } from '../../apps/server/src/lib/crypto.mjs';
// The test deployment is realm 'default' at https://id.vibernt.ai, configured as an operator would (scripts/realm.mjs).
export async function world(t, policy = 'open') {
    const mails = [], pending = [];
    const base = {
        SEALING_KEY: 'ab'.repeat(32), EMAIL_FROM: 'signin@vibernt.ai',
        TURNSTILE_SECRET: 'test-secret', TURNSTILE_SITE_KEY: 'test-site-key',
        GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
        GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret',
        DB: d1Database(), EMAIL: { async send(mail) { mails.push(mail); return { messageId: 'test' }; } },
        AUTH_LIMITER: { async limit() { return { success: true }; } },
        API_LIMITER: { async limit() { return { success: true }; } },
        AGENT_LIMITER: { async limit() { return { success: true }; } }
    };
    base.DB.db.prepare("UPDATE realms SET issuer='https://id.vibernt.ai', display_name='Vibernt' WHERE id='default'").run();
    base.DB.db.prepare("INSERT INTO admins(realm_id,email,role,created) VALUES('default','admin@example.com','platform',0)").run();
    const env = realmEnv(base, base.DB.db.prepare("SELECT * FROM realms WHERE id='default'").get());
    t.after(() => env.DB.db.close());
    for (const id of ['app', 'other']) await env.DB.prepare(`INSERT INTO clients
        (id,secret_hash,redirect_uris,post_logout_uris,signup_policy,sign_in_methods) VALUES(?,?,?,?,?,?)`)
        .bind(id, await sha256('secret'), JSON.stringify(['https://app.example/callback']), JSON.stringify(['https://app.example/bye']), policy, JSON.stringify(['email', 'github', 'google'])).run();
    const context = { waitUntil(promise) { pending.push(promise); } };
    const call = (path, init = {}) => worker.fetch(new Request(env.ISSUER + path, init), env, context);
    const post = (path, body, cookie = '', extra = {}) => call(path, { method: 'POST', headers: {
        'content-type': 'application/json', origin: env.ISSUER, cookie, ...extra
    }, body: JSON.stringify(body) });
    const verifier = 'v'.repeat(43);
    const authorize = async (changes = {}, cookie = '') => {
        const query = { client_id: 'app', redirect_uri: 'https://app.example/callback', response_type: 'code',
            scope: 'openid email', state: 'rp-state', nonce: 'rp-nonce', code_challenge: await challengeOf(verifier), code_challenge_method: 'S256', ...changes };
        for (const key of Object.keys(query)) if (query[key] === null) delete query[key];
        return call('/authorize?' + new URLSearchParams(query), { headers: { cookie } });
    };
    const exchange = (code, changes = {}, auth = basic()) => call('/token', { method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', authorization: auth
    }, body: new URLSearchParams({ grant_type: 'authorization_code', code,
        redirect_uri: 'https://app.example/callback', code_verifier: verifier, ...changes }) });
    return { env, mails, call, post, authorize, exchange, verifier, async drain() { await Promise.all(pending.splice(0)); } };
}
export const basic = (id = 'app', secret = 'secret') => 'Basic ' + btoa(`${id}:${secret}`);
export const cookieJar = response => response.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
export async function begin(w, cookie = '', changes = {}) {
    const response = await w.authorize(changes, cookie);
    const html = await response.text();
    return { response, cookie: cookieJar(response), request_id: html.match(/data-request-id="([^"]+)"/)[1] };
}
export function turnstile(t, overrides = {}) {
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (!String(url).includes('challenges.cloudflare.com')) throw new Error('Unexpected network request');
        return Response.json({ success: true, action: 'sign_in', hostname: 'id.vibernt.ai', ...overrides });
    });
}
export async function login(w, t, email = 'person@example.com') {
    turnstile(t);
    const flow = await begin(w);
    await w.post('/v1/auth/magic/request', { request_id: flow.request_id, email, turnstile: crypto.randomUUID() }, flow.cookie);
    await w.drain();
    const token = w.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const response = await w.post('/v1/auth/magic/verify', { token }, flow.cookie);
    return { response, cookie: cookieJar(response), code: new URL(response.headers.get('location')).searchParams.get('code'), flow, token };
}
