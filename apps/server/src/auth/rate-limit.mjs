// Assay rate-limit.mjs binding path; missing bindings fail explicitly, with no D1 fallback.
import { invariant } from '../lib/errors.mjs';
import { sha256 } from '../lib/crypto.mjs';
// IPv6 clients control at least a /64, so every per-address budget is keyed on the /64 (S7, S8).
export function clientAddress(request) {
    const ip = request.headers.get('cf-connecting-ip') || 'unavailable';
    if (!ip.includes(':')) return ip;
    const [head, tail = ''] = ip.toLowerCase().split('::');
    const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
    if (right.at(-1)?.includes('.')) return ip; // IPv4-embedded forms are rare; keep them exact.
    const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
    return groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
// Binding limiters: `key` names the bucket; callers pass an authenticated client id where one exists (S2).
export async function limitKey(env, binding, key) {
    invariant(typeof env[binding]?.limit === 'function', 'rate_limit_config', `${binding} is not configured.`, 503);
    const result = await env[binding].limit({ key: await sha256(key) });
    invariant(result?.success === true, 'rate_limit', 'Too many requests.', 429);
}
export const limitAddress = (env, request, binding = 'API_LIMITER') => limitKey(env, binding, 'ip:' + clientAddress(request));
export const limitClient = (env, clientId) => limitKey(env, 'API_LIMITER', 'client:' + clientId);
// Admission-independent D1 budget, ported from magic.mjs. This is a separate global budget.
async function budget(env, key, max, windowMs = 3600000) {
    const now = Date.now();
    const row = await env.DB.prepare(`INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
        ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
        expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`)
        .bind(key, now + windowMs, now, now).first();
    return row.count <= max;
}
// Two budgets: per recipient and address, and a global per-recipient cap that rotating addresses cannot avoid (S8).
export async function limitEmail(env, email, request, degraded = false) {
    const recipient = await budget(env, 'email-recipient:' + await sha256(email), degraded ? 3 : 5);
    const pair = await budget(env, `${degraded ? 'email-degraded' : 'email'}:` + await sha256(`${email}\n${clientAddress(request)}`), degraded ? 2 : 5);
    return recipient && pair;
}
export async function limitDegradedAddress(env, request) {
    return budget(env, 'turnstile-degraded-ip:' + await sha256(clientAddress(request)), 5);
}
export async function limitAgentAddress(env, request, action, max = 20) {
    const key = 'agent-' + action + ':' + await sha256(clientAddress(request));
    invariant(await budget(env, key, max), 'rate_limit', 'Too many agent requests.', 429);
}
// Failure lockout (no enumeration: keys exist for unknown accounts too). An attempt is counted atomically before
// the secret is checked, so parallel guesses cannot pass the limit; the attempt that reaches the limit starts a
// fifteen-minute lock. A success clears the key.
export const PASSWORD_FAILURE_LIMIT = 10, FAILURE_WINDOW_MS = 900000;
export async function attempt(env, key, limit = PASSWORD_FAILURE_LIMIT) {
    const now = Date.now();
    const row = await env.DB.prepare(`INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
        ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
        expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at WHEN count+1>=? THEN ? ELSE expires_at END RETURNING count`)
        .bind(key, now + FAILURE_WINDOW_MS, now, now, limit, now + FAILURE_WINDOW_MS).first();
    return row.count <= limit;
}
export const clearFailures = (env, key) => env.DB.prepare('DELETE FROM rate_limits WHERE key=?').bind(key).run();
export const passwordKey = async (env, email) => 'pw-fail:' + await sha256(`${env.REALM.id}\n${email}`);
export const mfaFailureKey = userId => 'mfa-fail:' + userId;
