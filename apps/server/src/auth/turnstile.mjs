// Ported from Assay: bounded siteverify, replay protection and existing-user outage mode.
import { invariant } from '../lib/errors.mjs';
import { sha256 } from '../lib/crypto.mjs';
export async function requireTurnstile(env, token, request) {
    if (!env.TURNSTILE_SECRET && !env.TURNSTILE_SITE_KEY) return { mode: 'off' };
    invariant(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY, 'turnstile_config', 'Turnstile keys are not configured.', 503);
    invariant(!/^([123])x0{10}/.test(env.TURNSTILE_SECRET) && !/^([123])x0{10}/.test(env.TURNSTILE_SITE_KEY), 'turnstile_config', 'Test Turnstile keys are prohibited on this issuer.', 503);
    invariant(typeof token === 'string' && token.length > 0 && token.length <= 2048, 'turnstile_required', 'Complete the human check.');
    let response;
    try {
        response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(4000),
            body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token,
                remoteip: request.headers.get('cf-connecting-ip') || undefined, idempotency_key: crypto.randomUUID() })
        });
    } catch { return unavailable('network'); }
    if (!response.ok) {
        if (response.status >= 500 || response.status === 429) return unavailable(`http-${response.status}`);
        invariant(false, 'turnstile_config', 'Turnstile siteverify rejected the request.', 503);
    }
    let value;
    try { value = await response.json(); } catch { return unavailable('malformed'); }
    if (!value || typeof value.success !== 'boolean') return unavailable('malformed');
    if (value['error-codes']?.includes('internal-error')) return unavailable('internal-error');
    invariant(!value['error-codes']?.some(x => ['missing-input-secret', 'invalid-input-secret'].includes(x)), 'turnstile_config', 'Turnstile rejected its secret.', 503);
    invariant(value.success === true && value.action === 'sign_in' && value.hostname === new URL(env.ISSUER).hostname,
        'turnstile_invalid', 'Human verification failed.');
    const claimed = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO NOTHING RETURNING count')
        .bind('turnstile:' + await sha256(token), Date.now() + 600000).first();
    invariant(claimed, 'turnstile_invalid', 'Human verification has already been used.');
    return { mode: 'verified' };
}
function unavailable(reason) {
    console.error(JSON.stringify({ type: 'turnstile_unavailable', action: 'sign_in', reason }));
    return { mode: 'degraded' };
}
