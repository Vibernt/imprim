import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256 } from '../lib/crypto.mjs';
import { tokenShape, redirect } from '../lib/http.mjs';
import { getSession, cookies, cookie, BROWSER_COOKIE } from '../auth/session.mjs';
import { allowsMethod } from '../oidc/sign-in-methods.mjs';
import { signInPage } from '../pages/sign-in.mjs';
import { checkPolicy } from './policy.mjs';
import { limitAgentAddress } from '../auth/rate-limit.mjs';
import { matchRedirect } from './uris.mjs';
export async function authorizeAgent(request, env, query) {
    // /authorize can fetch an agent's metadata document anonymously, so it spends the same budget as registration (S10).
    await limitAgentAddress(env, request, 'authorize', 60);
    const context = await checkPolicy(env, query);
    matchRedirect(context.agent, query.redirect_uri);
    invariant(context.agent.grant_types.includes('authorization_code'), 'unauthorized_client', 'Code flow is not registered.');
    invariant(query.response_type === 'code', 'unsupported_response_type', 'Only code is supported.');
    invariant(query.code_challenge_method === 'S256' && tokenShape(query.code_challenge), 'invalid_request', 'PKCE S256 required.');
    invariant(typeof query.state === 'string' && query.state.length > 0 && query.state.length <= 512, 'invalid_request', 'state required.');
    invariant(query.prompt === undefined || ['none','login','consent'].includes(query.prompt), 'invalid_request', 'Unsupported prompt.');
    invariant(!query.response_mode || query.response_mode === 'query', 'invalid_request', 'Only query responses supported.');
    for (const key of ['request','request_uri','claims','max_age','id_token_hint']) invariant(query[key] === undefined, 'invalid_request', 'Unsupported authorization parameter.');
    // An agent always needs explicit consent, including when an identity session already exists.
    invariant(query.prompt !== 'none', 'consent_required', 'Agent authorization requires consent.');
    return beginAgentSignIn(request, env, query, context);
}
export async function beginAgentSignIn(request, env, values, context, deviceHash = null) {
    const existing = cookies(request)[BROWSER_COOKIE], browser = tokenShape(existing) ? existing : randomToken();
    const id = randomToken(), responseCookies = [cookie(BROWSER_COOKIE, browser, 1800)];
    await env.DB.prepare(`INSERT INTO auth_requests(id,client_id,redirect_uri,state,nonce,challenge,scope,browser_hash,expires_at,agent_client_id,resource,device_hash,prompt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, context.app.id, values.redirect_uri || `${env.ISSUER}/device`, values.state || '', '',
        values.code_challenge || '', values.scope, await sha256(browser), Date.now() + 1800000, values.client_id, values.resource, deviceHash, values.prompt === 'login' ? 'login' : null).run();
    const session = values.prompt === 'login' ? null : await getSession(request, env);
    if (session && allowsMethod(context.app, session.method, session.google_hd, true)) return redirect(`${env.ISSUER}/agent/consent?request_id=${id}`, responseCookies);
    return signInPage(env, id, responseCookies, context.app);
}
export async function validateAgentRequest(env, row, session) {
    const context = await checkPolicy(env, { client_id: row.agent_client_id, app_id: row.client_id, resource: row.resource, scope: row.scope }, session);
    invariant(context.agent.grant_types.includes(row.device_hash ? 'urn:ietf:params:oauth:grant-type:device_code' : 'authorization_code'), 'unauthorized_client', 'Grant type is no longer registered.');
    if (row.device_hash) {
        const device = await env.DB.prepare("SELECT * FROM agent_devices WHERE hash=? AND status='pending' AND expires_at>?").bind(row.device_hash, Date.now()).first();
        invariant(device && device.client_id === row.agent_client_id && device.app_id === row.client_id && device.resource === row.resource && device.scope === row.scope,
            'expired_token', 'Device request expired or already completed.');
    } else matchRedirect(context.agent, row.redirect_uri);
    return context;
}
