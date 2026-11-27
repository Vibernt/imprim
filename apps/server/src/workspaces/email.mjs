import { msg, recipientLocale } from '../i18n/index.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { sendEmail } from '../services/email/send.mjs';

export const noSignInAddress = msg('No app in this workspace has a sign-in address yet. Ask your administrator.');
const addressPath = "substr(c.initiate_login_uri,1,min(instr(c.initiate_login_uri||'?','?'),instr(c.initiate_login_uri||'#','#'))-1)";
const hasAddress = `c.initiate_login_uri IS NOT NULL AND c.initiate_login_uri<>'' AND lower(rtrim(${addressPath},'/'))<>lower(?)`;
const sharedProductApp = "c.workspaces='shared' AND c.product IN";

// The write batch checks address availability before replacing an invitation or creating a team.
export function invitationAddressCheck(env, client, id, products) {
    const args = [realmId(env), `${env.ISSUER}/login`];
    const scope = client ? 'c.id=?' : `${sharedProductApp} (${products
        ? 'SELECT value FROM json_each(?)' : 'SELECT product FROM workspace_products WHERE workspace_id=?'})`;
    return { sql: `EXISTS(SELECT 1 FROM clients c WHERE c.realm_id=? AND ${hasAddress} AND ${scope})`,
        args: [...args, client ? client.id : products ? JSON.stringify(products) : id] };
}

// Retained for team sign-up status mail, which is independent of workspace invitations.
export function workspaceSignInLink(issuer, configured) {
    if (configured === null) return `${issuer}/login`;
    return checkedAddress(configured);
}

function checkedAddress(configured) {
    let url;
    try { url = new URL(configured); } catch { /* Invalid URL is reported below. */ }
    invariant(url?.protocol === 'https:' && /^https:\/\//i.test(configured) && !url.username && !url.password && !/[\s\\]/.test(configured),
        'workspace_invitation_link', 'The workspace invitation sign-in URL is invalid.', 503);
    return configured;
}

// The caller owns the lifetime of this post-commit task. Resolve the message from the persisted invitation.
// The verified console actor's email is supplied for invitations without a user or calling app.
export async function sendWorkspaceInvitation(env, ctx, invitation) {
    const row = await env.DB.prepare(`SELECT i.email, w.name, i.via_client, app.id AS client_id,
            CASE WHEN i.via_client IS NOT NULL THEN app.initiate_login_uri ELSE (
                SELECT c.initiate_login_uri FROM clients c
                LEFT JOIN client_admissions a ON a.client_id=c.id AND a.user_id=coalesce(i.invited_by,?)
                WHERE c.realm_id=w.realm_id AND ${hasAddress}
                    AND ${sharedProductApp} (SELECT product FROM workspace_products WHERE workspace_id=w.id)
                ORDER BY a.last_signed_in DESC,coalesce(nullif(json_extract(c.branding,'$.name'),''),c.id) COLLATE NOCASE,c.id
                LIMIT 1) END AS initiate_login_uri,
            CASE WHEN i.invited_by IS NULL AND i.via_client IS NULL THEN a.email ELSE inviter.email END AS inviter_email,
            recipient.locale,
            (SELECT json_group_array(product) FROM
                (SELECT product FROM workspace_products WHERE workspace_id=w.id ORDER BY product)) AS products
        FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id
        LEFT JOIN clients app ON app.id=i.via_client AND app.realm_id=w.realm_id
        LEFT JOIN users inviter ON inviter.id=i.invited_by AND inviter.realm_id=w.realm_id
        LEFT JOIN users recipient ON recipient.email=i.email AND recipient.realm_id=w.realm_id
        LEFT JOIN admins a ON a.email=? AND a.realm_id=w.realm_id
        WHERE i.id=? AND w.realm_id=? AND w.kind='team' AND w.status='active'
            AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?`)
        .bind(invitation.inviterId ?? null, `${env.ISSUER}/login`, invitation.inviterEmail ?? null,
            invitation.invitationId, realmId(env), Date.now()).first();
    invariant(row, 'workspace_invitation_unavailable', 'The workspace invitation is unavailable.', 404);
    invariant(row.inviter_email && (row.via_client === null || row.client_id), 'workspace_invitation_sender',
        'The workspace invitation sender is unavailable.', 503);
    invariant(row.initiate_login_uri, 'no_sign_in_address', noSignInAddress, 409);
    const address = checkedAddress(row.initiate_login_uri), url = new URL(address);
    const pathname = url.pathname.replace(/%([0-9a-f]{2})/gi, (_, byte) => String.fromCharCode(parseInt(byte, 16)));
    invariant(url.origin !== env.ISSUER || !/^\/login\/*$/.test(pathname),
        'no_sign_in_address', noSignInAddress, 409);
    invariant(typeof env.EMAIL?.send === 'function' && env.EMAIL_FROM, 'email_config', 'Transactional email is not configured.', 503);
    const locale = recipientLocale(env, row.locale);
    const products = new Intl.ListFormat(locale).format(JSON.parse(row.products));
    await sendEmail(env, {
        kind: 'workspace_invitation', to: row.email, locale,
        vars: { inviter: row.inviter_email, workspace: row.name, products },
        links: { invitation_url: address }
    });
}
