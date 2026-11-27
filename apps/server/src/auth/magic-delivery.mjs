import { randomToken, sha256 } from '../lib/crypto.mjs';
import { realmId } from '../realms/realm.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { sendEmail } from '../services/email/send.mjs';

const linkKinds = { sign_in: 'sign_in_link', password: 'password_link', signup: 'signup_link' };

export async function deliverMagicLink(env, pending, browserHash, {
    email, purpose, workspace_name = null, provider = null, provider_id = null, provider_login = null
}) {
    const token = randomToken(), hash = await sha256(token), realm = realmId(env), requestId = pending?.row.id;
    await env.DB.prepare(`INSERT INTO magic_links(hash,email,request_id,browser_hash,expires_at,realm_id,purpose,
        workspace_name,provider,provider_id,provider_login) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(hash, email, requestId ?? null, browserHash, Date.now() + 900000, realm, purpose,
            workspace_name, provider, provider_id, provider_login).run();
    // The request id brings back the app's sign-in page. The token stays in the fragment.
    const link = `${env.ISSUER}/login${requestId ? `?request_id=${encodeURIComponent(requestId)}` : ''}#token=${token}`;
    try {
        await sendEmail(env, { kind: linkKinds[purpose], to: email, branding: brandingFor(env, pending?.client), links: { link } });
    } catch (error) {
        await env.DB.prepare('DELETE FROM magic_links WHERE hash=? AND realm_id=?').bind(hash, realm).run();
        throw error;
    }
}
