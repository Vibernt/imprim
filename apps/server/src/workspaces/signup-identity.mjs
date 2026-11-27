import { msg } from '../i18n/index.mjs';
import { realmId } from '../realms/realm.mjs';
import { signupGuard } from './signup-guards.mjs';

const identityConflict = msg('This provider is linked to another account.');
const linkedOwner = 'SELECT user_id FROM user_identities WHERE realm_id=? AND provider=? AND provider_id=?';

export function signupProviderGuard(env, { email, provider, provider_id }) {
    return signupGuard(`NOT EXISTS(${linkedOwner} AND user_id IS NOT
        (SELECT id FROM users WHERE realm_id=? AND email=?))`,
    [realmId(env), provider, provider_id, realmId(env), email], 'conflict', identityConflict);
}

export function signupProviderEffects(env, signup, owner, now, approval) {
    const { provider, provider_id, provider_login } = signup;
    const args = [realmId(env), provider, provider_id];
    const insert = env.DB.prepare(`INSERT INTO user_identities(realm_id,provider,provider_id,user_id,login,created)
        VALUES(?,?,?,?,?,?) ON CONFLICT(realm_id,provider,provider_id) DO NOTHING`).bind(...args, owner, provider_login, now);
    const owned = `EXISTS(${linkedOwner} AND user_id=?)`;
    const check = env.DB.prepare(`INSERT INTO admin_assertions(ok) VALUES(${owned})`).bind(...args, owner);
    return approval ? { effects: [insert], auditFlags: { provider_link_skipped: { sql: `NOT ${owned}`, args: [...args, owner] } } }
        : { effects: [insert, check] };
}
