import { recipientLocale } from '../i18n/index.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { sendEmail } from '../services/email/send.mjs';

function invitationLink(issuer, configured) {
    if (configured === null) return `${issuer}/login`;
    let url;
    try { url = new URL(configured); } catch { /* Invalid URL is reported below. */ }
    invariant(url?.protocol === 'https:' && configured.startsWith('https://') && !url.username && !url.password && !/[\s\\]/.test(configured),
        'workspace_invitation_link', 'The workspace invitation sign-in URL is invalid.', 503);
    return configured;
}

// The caller owns the lifetime of this post-commit task. Resolve the message from the persisted invitation.
// The verified console actor's email is supplied for invitations without a user or calling app.
export async function sendWorkspaceInvitation(env, ctx, invitation) {
    const row = await env.DB.prepare(`SELECT i.email, w.name, i.via_client, c.id AS client_id, c.initiate_login_uri,
            CASE WHEN i.invited_by IS NULL AND i.via_client IS NULL THEN a.email ELSE inviter.email END AS inviter_email,
            recipient.locale,
            (SELECT json_group_array(product) FROM
                (SELECT product FROM workspace_products WHERE workspace_id=w.id ORDER BY product)) AS products
        FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id
        LEFT JOIN clients c ON c.id=i.via_client AND c.realm_id=w.realm_id
        LEFT JOIN users inviter ON inviter.id=i.invited_by AND inviter.realm_id=w.realm_id
        LEFT JOIN users recipient ON recipient.email=i.email AND recipient.realm_id=w.realm_id
        LEFT JOIN admins a ON a.email=? AND a.realm_id=w.realm_id
        WHERE i.id=? AND w.realm_id=? AND w.kind='team' AND w.status='active'
            AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?`)
        .bind(invitation.inviterEmail ?? null, invitation.invitationId, realmId(env), Date.now()).first();
    invariant(row, 'workspace_invitation_unavailable', 'The workspace invitation is unavailable.', 404);
    invariant(row.inviter_email && (row.via_client === null || row.client_id), 'workspace_invitation_sender',
        'The workspace invitation sender is unavailable.', 503);
    invariant(typeof env.EMAIL?.send === 'function' && env.EMAIL_FROM, 'email_config', 'Transactional email is not configured.', 503);
    const locale = recipientLocale(env, row.locale);
    const products = new Intl.ListFormat(locale).format(JSON.parse(row.products));
    await sendEmail(env, {
        kind: 'workspace_invitation', to: row.email, locale,
        vars: { inviter: row.inviter_email, workspace: row.name, products },
        links: { invitation_url: invitationLink(env.ISSUER, row.initiate_login_uri) }
    });
}
