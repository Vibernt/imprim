import { invariant } from '../lib/errors.mjs';
import { ownIdToken } from '../oidc/logout-hint.mjs';
import { realmId } from '../realms/realm.mjs';

export const liveActorSession = `FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.sid=? AND s.user_id=? AND s.expires_at>? AND u.realm_id=? AND u.status='active' AND u.merged_into IS NULL`;

export async function verifyActor(env, client, actorToken) {
    const claims = await ownIdToken(env, actorToken, 'actor token');
    invariant(claims.aud === client.id, 'invalid_request', 'Actor token was issued to another app.');
    const row = await env.DB.prepare(`SELECT s.*,u.email,u.email_verified ${liveActorSession}`)
        .bind(claims.sid, claims.sub, Date.now(), realmId(env)).first();
    invariant(row, 'invalid_request', 'Actor token does not name a live session.');
    const { email, email_verified, ...session } = row;
    return { user: { id: session.user_id, email, email_verified }, session };
}
