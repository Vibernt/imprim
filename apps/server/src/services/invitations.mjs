import { authenticatedClient } from '../oidc/token.mjs';
import { readBody, json } from '../lib/http.mjs';
import { normalizeEmail } from './admission.mjs';
import { audit } from './audit.mjs';
export async function invite(request, env) {
    const body = await readBody(request), client = await authenticatedClient(request, env, body, true);
    const email = normalizeEmail(body.email), expires = Date.now() + 30 * 86400000;
    await env.DB.prepare(`INSERT INTO invitations(client_id,email,expires_at) VALUES(?,?,?)
        ON CONFLICT(client_id,email) DO UPDATE SET expires_at=excluded.expires_at`).bind(client.id, email, expires).run();
    await audit(env, 'invitation_registered', client.id);
    return json({ accepted: true, expires_at: expires }, 201);
}
