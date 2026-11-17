import { liveGrantGuard } from './guards.mjs';
import { limitAgentGrant } from '../auth/rate-limit.mjs';
import { invariant } from '../lib/errors.mjs';
import { readBody, json, uniqueParams, tokenShape } from '../lib/http.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { limitAgentAddress } from '../auth/rate-limit.mjs';
import { page } from '../pages/layout.mjs';
import { result, field, button } from '../pages/ui.mjs';
import { checkPolicy } from './policy.mjs';
import { authenticateAgent } from './client-auth.mjs';
import { beginAgentSignIn } from './authorize.mjs';
import { t } from '../i18n/index.mjs';
import { grantContext, tokenMaterial, usageStatements, dpopFor, bindStatement } from './grants.mjs';
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';
export async function deviceAuthorization(request, env) {
    await limitAgentAddress(env, request, 'device');
    invariant(!request.headers.has('authorization'), 'invalid_client', 'Public client required.');
    const body = await readBody(request, 'form');
    invariant(!Object.hasOwn(body, 'client_secret'), 'invalid_client', 'Public client required.');
    const { app, agent } = await checkPolicy(env, body);
    invariant(agent.grant_types.includes(DEVICE), 'unauthorized_client', 'Device flow is not registered.');
    await authenticateAgent(env, agent, body, '/device_authorization');
    const deviceCode = randomToken();
    const alphabet = 'BCDFGHJKLMNPQRSTVWXZ';
    // Rejection sampling over all 20 letters keeps each equally likely: 20^8 is about 2^34.6 (S7).
    let code = '';
    while (code.length < 8) { const n = crypto.getRandomValues(new Uint8Array(1))[0]; if (n < 240) code += alphabet[n % alphabet.length]; }
    const userCode = code.slice(0,4) + '-' + code.slice(4), now = Date.now();
    await env.DB.prepare(`INSERT INTO agent_devices(hash,user_code_hash,client_id,app_id,resource,scope,expires_at,next_poll) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(await sha256(deviceCode), await sha256(code), body.client_id, app.id, body.resource, body.scope, now + 600000, now + 5000).run();
    return json({ device_code: deviceCode, user_code: userCode, verification_uri: `${env.ISSUER}/device`,
        verification_uri_complete: `${env.ISSUER}/device?user_code=${userCode}`, expires_in: 600, interval: 5 });
}
export async function devicePage(request, env) {
    const query = uniqueParams(new URL(request.url).searchParams);
    if (!query.user_code) return page(t(env, 'Connect a device'), result('bot', 'accent', t(env, 'Connect a device'), t(env, 'Enter the code your agent shows you.')) +
        `<form class="fd-stack" data-gap="4" method="get" action="/device">${field({ id: 'user_code', label: t(env, 'Device code'), name: 'user_code', required: true, autocomplete: 'off',
            spellcheck: 'false', size: 'lg', placeholder: 'BCDF-GHJK', hint: t(env, 'Only enter a code from an agent you started yourself.') })}${button(t(env, 'Continue'), { variant: 'primary', size: 'lg', block: true })}</form>`);
    await limitAgentAddress(env, request, 'user-code');
    const code = query.user_code.replaceAll('-', '').toUpperCase();
    invariant(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(code), 'invalid_request', 'That code isn’t valid. Codes are 8 letters, like BCDF-GHJK.');
    const row = await env.DB.prepare("SELECT * FROM agent_devices WHERE user_code_hash=? AND expires_at>? AND status='pending'").bind(await sha256(code), Date.now()).first();
    invariant(row, 'expired_token', 'This code has expired, was already used or doesn’t exist. Get a new code from your agent.');
    const context = await checkPolicy(env, row);
    return beginAgentSignIn(request, env, row, context, row.hash);
}
export async function pollDevice(env, body, jkt = null) {
    invariant(tokenShape(body.device_code), 'invalid_grant', 'Device code required.');
    const hash = await sha256(body.device_code), now = Date.now();
    let row = await env.DB.prepare('SELECT * FROM agent_devices WHERE hash=?').bind(hash).first();
    invariant(row && row.client_id === body.client_id && row.resource === body.resource, 'invalid_grant', 'Device client or resource mismatch.');
    invariant(row.expires_at > now, 'expired_token', 'Device code expired.');
    const context = await checkPolicy(env, row);
    invariant(context.agent.grant_types.includes(DEVICE), 'unauthorized_client', 'Device flow is no longer registered.');
    await authenticateAgent(env, context.agent, body, '/token');
    invariant(row.status !== 'denied', 'access_denied', 'Device authorization denied.');
    invariant(row.status !== 'consumed', 'invalid_grant', 'Device code already used.');
    // Poll scheduling is an atomic update. A concurrent/early poll adds five seconds permanently.
    const marker = crypto.randomUUID();
    row = await env.DB.prepare(`UPDATE agent_devices SET
        interval=CASE WHEN next_poll>? THEN interval+5 ELSE interval END,
        next_poll=? + (interval + CASE WHEN next_poll>? THEN 5 ELSE 0 END)*1000,
        poll_marker=CASE WHEN next_poll<=? THEN ? ELSE NULL END
        WHERE hash=? AND expires_at>? AND status IN ('pending','approved') RETURNING *`)
        .bind(now, now, now, now, marker, hash, now).first();
    invariant(row, 'invalid_grant', 'Device request unavailable.');
    invariant(row.poll_marker === marker, 'slow_down', 'Increase the polling interval by five seconds.');
    invariant(row.status === 'approved', 'authorization_pending', 'Waiting for human consent.');
    const { grant, app } = await grantContext(env, row.grant_id);
    await limitAgentGrant(env, grant, app);
    const bound = dpopFor(app, grant, jkt), material = await tokenMaterial(env, grant, grant.scope, bound);
    const guard = liveGrantGuard(grant, app, Date.now());
    const result = await env.DB.batch([
        env.DB.prepare(`INSERT INTO agent_refresh_tokens(hash,grant_id,created) SELECT ?,d.grant_id,? FROM agent_devices d JOIN agent_grants g ON g.id=d.grant_id
            WHERE d.hash=? AND d.status='approved' AND d.expires_at>? AND g.revoked_at IS NULL AND g.expires_at>? AND ${guard.sql}
            AND EXISTS(SELECT 1 FROM client_admissions a WHERE a.user_id=g.user_id AND a.client_id=g.app_id)`).bind(material.hash, Date.now(), hash, Date.now(), Date.now(), ...guard.args),
        env.DB.prepare("UPDATE agent_devices SET status='consumed' WHERE hash=? AND EXISTS(SELECT 1 FROM agent_refresh_tokens WHERE hash=?)").bind(hash, material.hash),
        ...(bound ? [bindStatement(env, grant, bound, material.hash)] : [])
    ]);
    invariant(result[0].meta.changes === 1, 'invalid_grant', 'Device code already used or grant revoked.');
    await env.DB.batch(usageStatements(env, grant, 'agent_token'));
    return json(material.response);
}
