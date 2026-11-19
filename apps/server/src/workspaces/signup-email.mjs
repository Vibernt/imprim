import { brandingFor } from '../branding/tokens.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { audit } from '../services/audit.mjs';
import { sendEmail } from '../services/email/send.mjs';
import { workspaceSignInLink } from './email.mjs';

function send(env, options) {
    invariant(typeof env.EMAIL?.send === 'function' && env.EMAIL_FROM, 'email_config', 'Transactional email is not configured.', 503);
    return sendEmail(env, options);
}

export async function notifySignupAdmins(env, client, request) {
    try {
        const { results } = await env.DB.prepare('SELECT email FROM admins WHERE realm_id=? ORDER BY email').bind(realmId(env)).all();
        const resultsByAdmin = await Promise.allSettled(results.map(async ({ email: to }) => send(env, {
            kind: 'signup_admin_request', to, locale: 'en',
            vars: { email: request.email, app: JSON.parse(client.branding || '{}').name ?? client.id,
                client: client.id, product: request.product, workspace: request.workspace_name },
            links: { requests_url: `${env.ISSUER}/admin/signups` }
        })));
        const failed = resultsByAdmin.filter(result => result.status === 'rejected').length;
        if (failed) await audit(env, 'signup_email_failed', null, { request_id: request.id, kind: 'signup_admin_request', failed });
    } catch {
        console.error(JSON.stringify({ type: 'signup_email_failed', request_id: request.id, kind: 'signup_admin_request' }));
    }
}

export async function notifySignupDecision(env, client, request, status, approver) {
    const kind = status === 'approved' ? 'signup_approved' : 'signup_declined';
    try {
        await send(env, { kind, to: request.email, locale: request.locale, branding: brandingFor(env, client),
            links: status === 'approved' ? { app_url: workspaceSignInLink(env.ISSUER, client.initiate_login_uri) } : {} });
        return { state: 'sent' };
    } catch {
        await audit(env, 'signup_email_failed', approver, { request_id: request.id, kind }).catch(() => {
            console.error(JSON.stringify({ type: 'signup_email_failed', request_id: request.id, kind }));
        });
        return { state: 'failed', message: 'The decision is saved. Email delivery failed.' };
    }
}
