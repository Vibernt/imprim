import { invariant } from '../lib/errors.mjs';
import { json, uniqueParams, validSub } from '../lib/http.mjs';
import { authenticatedClient } from '../oidc/token.mjs';
import { realmId } from '../realms/realm.mjs';
import { admissionGuard } from '../services/admission.mjs';

export async function appUser(request, env, url) {
    const client = await authenticatedClient(request, env, {}, true);
    const { sub } = uniqueParams(url.searchParams);
    invariant(validSub(sub), 'invalid_request', 'Invalid sub.');

    const admission = admissionGuard('u.id', client.id);
    const user = await env.DB.prepare(`SELECT u.id AS sub,u.email,u.email_verified,u.display_name FROM users u
        WHERE u.id=? AND u.realm_id=? AND u.status='active' AND u.merged_into IS NULL AND ${admission.sql}`)
        .bind(sub, realmId(env), ...admission.args).first();
    invariant(user, 'not_found', 'Person not found.', 404);
    return json({ sub: user.sub, email: user.email, email_verified: user.email_verified === 1, name: user.display_name || null });
}
