// Token exchange (RFC 8693): app A turns an agent's access token for A into one for app B's resource, for the same
// person, with `act` recording the chain. B opts in by naming A and the most scopes A may obtain.
import { invariant } from '../lib/errors.mjs';
import { json } from '../lib/http.mjs';
import { ownerOf } from '../agents/policy.mjs';
import { agentSettings } from '../agents/settings.mjs';
import { signAgentJwt } from '../agents/grants.mjs';
import { localAccessToken, stillLive } from './endpoints.mjs';
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange', ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const depth = act => act ? 1 + depth(act.act) : 0;
export async function exchangeToken(env, client, body) {
    invariant(body.subject_token_type === ACCESS_TOKEN_TYPE && (body.requested_token_type ?? ACCESS_TOKEN_TYPE) === ACCESS_TOKEN_TYPE, 'invalid_request', 'Exchange an access token for an access token.');
    invariant(body.actor_token === undefined, 'invalid_request', 'The authenticated app is the actor; actor_token is not used.');
    const subject = await localAccessToken(env, body.subject_token);
    invariant(subject && !subject.cnf, 'invalid_grant', 'The subject token is invalid, expired or sender-constrained.');
    // Only a person's delegated token can be exchanged: a service token never becomes a token for another app.
    invariant(typeof subject.grant_id === 'string' && !subject.grant_id.startsWith('service:'), 'invalid_grant', 'Service tokens cannot be exchanged.');
    // The exchanging app must be the audience the token was issued to.
    invariant((await ownerOf(env, subject.aud).catch(() => null))?.id === client.id, 'invalid_grant', 'Only the app a token was issued to can exchange it.');
    invariant(await stillLive(env, subject), 'invalid_grant', 'The grant behind the subject token is no longer live.');
    invariant(depth(subject.act) < 4, 'invalid_grant', 'The delegation chain is too long.');
    invariant(typeof body.resource === 'string', 'invalid_target', 'Exactly one resource is required.');
    const target = await ownerOf(env, body.resource);
    invariant(target.id !== client.id, 'invalid_target', 'Use the original token for your own resources.');
    invariant(target.agent_dpop !== 'required', 'invalid_target', 'The target app requires DPoP-bound tokens; exchanged tokens are bearer tokens.');
    const allowed = JSON.parse(target.token_exchange_from || '{}')[client.id];
    invariant(Array.isArray(allowed), 'unauthorized_client', 'The target app does not accept exchanges from this app.', 400);
    const catalogue = agentSettings(target).agent_scope_catalogue;
    const asked = body.scope === undefined ? allowed : String(body.scope).split(' ');
    invariant(asked.length && new Set(asked).size === asked.length && asked.every(scope => allowed.includes(scope) && Object.hasOwn(catalogue, scope)), 'invalid_scope', 'Request scopes the target app allows this exchange.');
    const now = Math.floor(Date.now() / 1000), exp = Math.min(now + 60, subject.exp);
    invariant(exp > now, 'invalid_grant', 'The subject token has expired.');
    const act = { sub: `app:${client.id}`, client_id: client.id, ...(subject.act ? { act: subject.act } : {}) };
    const token = await signAgentJwt(env, { iss: env.ISSUER, aud: body.resource, sub: subject.sub, client_id: subject.client_id, grant_id: subject.grant_id,
        ...(subject.workspace_id === undefined ? {} : { workspace_id: subject.workspace_id }),
        ...(subject.grant_issued_at ? { grant_issued_at: subject.grant_issued_at } : {}), scope: asked.join(' '), act, jti: crypto.randomUUID(), iat: now, exp });
    return json({ access_token: token, issued_token_type: ACCESS_TOKEN_TYPE, token_type: 'Bearer', expires_in: exp - now, scope: asked.join(' ') });
}
