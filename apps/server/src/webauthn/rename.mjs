import { FRESH_MFA_MS } from '../auth/mfa.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';

export async function renamePasskey(env, session, { id, name }) {
    const now = Date.now();
    const fresh = now - FRESH_MFA_MS;
    invariant(session.mfa_at > fresh, 'mfa_required', 'Confirm with your current second factor at /mfa?next=/account/mfa first.', 403);
    invariant(typeof id === 'string' && /^[A-Za-z0-9_-]{16,1400}$/.test(id), 'invalid_request', 'Choose a passkey to rename.');
    const label = typeof name === 'string' ? name.trim() : '';
    invariant(label.length > 0 && label.length <= 60 && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\u200e\u200f]/.test(label),
        'invalid_request', 'Enter a passkey name of 1 to 60 characters.');
    const updated = await env.DB.prepare(`UPDATE webauthn_credentials SET name=? WHERE id=? AND user_id=? AND realm_id=?
        AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.hash=? AND s.user_id=webauthn_credentials.user_id AND s.expires_at>? AND s.mfa_at>?
            AND u.status='active' AND u.merged_into IS NULL) RETURNING id`)
        .bind(label, id, session.user_id, realmId(env), session.hash, now, fresh).first();
    invariant(updated, 'not_found', 'Passkey not found.', 404);
}
