import { agentToken } from '../agents/token.mjs';
import { serviceToken } from '../machines/service-token.mjs';
import { authenticateClient, registeredUri } from './clients.mjs';
import { readBody, json, tokenShape } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { sha256, challengeOf, randomToken } from '../lib/crypto.mjs';
import { sessionByHash } from '../auth/session.mjs';
import { signIdToken } from './jwt.mjs';
import { requireMethod } from './sign-in-methods.mjs';
import { audit } from '../services/audit.mjs';
import { admissionGuard } from '../services/admission.mjs';
import { limitAddress, limitClient } from '../auth/rate-limit.mjs';
// Failed client authentication spends the caller's address budget; an authenticated app spends its own (S2).
export async function authenticatedClient(request, env, body, confidentialOnly = false) {
    let client;
    try { client = await authenticateClient(request, env, body, confidentialOnly); }
    catch (error) { await limitAddress(env, request); throw error; }
    // Only a real credential may spend the app's shared budget. A public client is named by a bare client_id, so
    // anyone could drain it; its requests stay on the caller's address budget.
    if (client.secret_hash) await limitClient(env, client.id);
    else await limitAddress(env, request);
    return client;
}
export async function token(request, env, ctx) {
    const body = await readBody(request, 'form');
    if (body.grant_type === 'client_credentials') { await limitAddress(env, request); return serviceToken(request, env, body); }
    if (body.resource !== undefined || body.client_id?.startsWith('https://') || body.client_id?.startsWith('agent_') || ['refresh_token','urn:ietf:params:oauth:grant-type:device_code'].includes(body.grant_type)) {
        // Agents run on people's own machines, not shared Worker egress, so their budget stays per address.
        await limitAddress(env, request);
        return agentToken(request, env, body, ctx);
    }
    const client = await authenticatedClient(request, env, body);
    invariant(body.grant_type === 'authorization_code', 'unsupported_grant_type', 'Only authorization_code is supported.');
    invariant(tokenShape(body.code) && typeof body.code_verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier), 'invalid_grant', 'Invalid code or verifier.');
    try { registeredUri(client, body.redirect_uri); } catch { invariant(false, 'invalid_grant', 'Invalid redirect URI.'); }
    const hash = await sha256(body.code), challenge = await challengeOf(body.code_verifier), now = Date.now();
    const where = 'hash=? AND client_id=? AND redirect_uri=? AND challenge=? AND expires_at>?';
    const args = [hash, client.id, body.redirect_uri, challenge, now];
    const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO consumed_codes(hash,client_id,expires_at) SELECT hash,client_id,? FROM codes WHERE ${where}`)
            .bind(now + 86400000, ...args),
        env.DB.prepare(`DELETE FROM codes WHERE ${where} RETURNING *`).bind(...args)
    ]);
    const code = results[1].results[0];
    if (!code) {
        // A replayed code revokes the access token it issued (RFC 9700 section 4.2.4) (S16).
        const used = await env.DB.prepare('SELECT access_hash FROM consumed_codes WHERE hash=? AND client_id=?').bind(hash, client.id).first();
        if (used) await env.DB.batch([
            // The marker fences an issuance still in flight; the delete covers one that already finished.
            env.DB.prepare('UPDATE consumed_codes SET replayed=1 WHERE hash=?').bind(hash),
            env.DB.prepare('DELETE FROM access_tokens WHERE hash=?').bind(used.access_hash || ''),
            env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES('code_replay',?,?,?,?)").bind(client.id, JSON.stringify({ revoked_access_token: Boolean(used.access_hash) }), Date.now(), env.REALM.id)
        ]);
        invariant(false, 'invalid_grant', 'Code is invalid, expired, or already used.');
    }
    const session = await sessionByHash(env, code.session_hash);
    invariant(session, 'invalid_grant', 'Session or account unavailable.');
    requireMethod(client, session.method, session.google_hd, true);
    const idToken = await signIdToken(env, session, code), accessToken = randomToken();
    const accessHash = await sha256(accessToken), admission = admissionGuard('s.user_id', client.id);
    const issued = await env.DB.batch([
        env.DB.prepare(`INSERT INTO access_tokens(hash,session_hash,client_id,scope,expires_at)
            SELECT ?,s.hash,?,?,? FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.hash=? AND s.expires_at>? AND u.status='active' AND u.merged_into IS NULL AND ${admission.sql}
            AND NOT EXISTS(SELECT 1 FROM consumed_codes WHERE hash=? AND replayed=1)`)
            .bind(accessHash, client.id, code.scope, now + 600000, session.hash, Date.now(), ...admission.args, hash),
        env.DB.prepare('UPDATE consumed_codes SET access_hash=? WHERE hash=? AND EXISTS(SELECT 1 FROM access_tokens WHERE hash=?)').bind(accessHash, hash, accessHash),
        env.DB.prepare(`INSERT OR IGNORE INTO app_sessions(client_id,user_id,sid,created)
            SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM access_tokens WHERE hash=?)`)
            .bind(client.id, session.user_id, session.sid, now, accessHash)
    ]);
    invariant(issued[0].meta.changes === 1, 'invalid_grant', 'Session or account unavailable.');
    await audit(env, 'token_issued', session.user_id, { client_id: client.id });
    return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 600, id_token: idToken, scope: code.scope });
}
export async function userinfo(request, env) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.get('authorization') || '');
    invariant(match, 'invalid_token', 'A bearer access token is required.', 401);
    const row = await env.DB.prepare('SELECT * FROM access_tokens WHERE hash=? AND expires_at>?').bind(await sha256(match[1]), Date.now()).first();
    const session = row && await sessionByHash(env, row.session_hash);
    if (!session) await limitAddress(env, request);
    invariant(session, 'invalid_token', 'Access token expired or revoked.', 401);
    await limitClient(env, row.client_id);
    const scopes = row.scope.split(' ');
    return json({ sub: session.user_id, ...(scopes.includes('email') ? { email: session.email, email_verified: session.email_verified === 1 } : {}),
        ...(scopes.includes('profile') && session.display_name ? { name: session.display_name } : {}) });
}
