import { admitted, ensureUser, isAdmin, mailboxProof, recordAdmission } from '../services/admission.mjs';
import { invariant } from '../lib/errors.mjs';
import { claimMailbox } from '../services/access.mjs';
import { realmId } from '../realms/realm.mjs';
import { canSignInForWorkspaceJoin } from '../workspaces/join-policy.mjs';
// A stable provider subject retains its owner across email changes, unless that email belongs to someone else.
// A new provider subject links to an existing account only when the provider is authoritative for the mailbox, or
// when this browser already holds a session for that account (S4). A stale "verified" flag never takes over an account.
export async function inspectProviderIdentity(env, client, provider, profile, pending) {
    const realm = realmId(env);
    const linked = await env.DB.prepare(`SELECT u.* FROM user_identities i JOIN users u ON u.id=i.user_id
        WHERE i.realm_id=? AND i.provider=? AND i.provider_id=? AND u.realm_id=i.realm_id`).bind(realm, provider, profile.providerId).first();
    const matching = await env.DB.prepare('SELECT id,email,status,merged_into,email_verified FROM users WHERE realm_id=? AND lower(email)=lower(?)').bind(realm, profile.email).first();
    invariant(!linked || !matching || linked.id === matching.id || matching.merged_into === linked.id || (matching.status === 'deleted' && !matching.merged_into), 'access_denied', 'Account unavailable.', 403);
    const email = linked ? linked.email : profile.email;
    invariant(!await isAdmin(env, email) && !await isAdmin(env, profile.email), 'access_denied', 'Account unavailable.', 403);
    // A registry provider marked authoritative for the domain (trusted_domains) proves the mailbox, as Google's hd does.
    const proof = profile.email !== email ? 'provider' : profile.authoritative ? 'mailbox' : profile.verified === false ? 'claim' : mailboxProof(provider, profile.email, profile.hd);
    invariant(!linked || (linked.status === 'active' && !linked.merged_into), 'access_denied', 'Account unavailable.', 403);
    const allowed = await admitted(env, client, email, proof);
    const join = !allowed && await canSignInForWorkspaceJoin(env, pending, { userId: linked?.id ?? matching?.id, email });
    return { linked, matching, email, proof, allowed, join,
        needsLink: !linked && matching?.status === 'active' && !matching.merged_into && proof !== 'mailbox' };
}

export function requireProviderLink(identity, session) {
    invariant(!identity.needsLink || session?.user_id === identity.matching.id, 'link_required',
        'An account already uses this email. Sign in with an email link first, then continue with this provider in the same browser.', 403);
}

export async function providerIdentity(env, client, provider, profile, session = null, pending = null) {
    const identity = await inspectProviderIdentity(env, client, provider, profile, pending);
    return signInProviderIdentity(env, client, provider, profile, identity, session);
}

export async function signInProviderIdentity(env, client, provider, profile, identity, session) {
    requireProviderLink(identity, session);
    invariant(identity.allowed || identity.join, 'access_denied', 'Account unavailable.', 403);
    const { linked, matching, email, proof, allowed } = identity, realm = realmId(env);
    // Mailbox proof for an unverified account clears identities linked on another provider's word.
    if (!linked && proof === 'mailbox' && matching?.status === 'active' && !matching.merged_into) await claimMailbox(env, matching);
    const user = linked || await ensureUser(env, email, proof === 'mailbox');
    await env.DB.prepare(`INSERT INTO user_identities(realm_id,provider,provider_id,user_id,login,created) VALUES(?,?,?,?,?,?)
        ON CONFLICT(realm_id,provider,provider_id) DO UPDATE SET login=excluded.login WHERE user_identities.user_id=excluded.user_id`)
        .bind(realm, provider, profile.providerId, user.id, profile.login ?? null, Date.now()).run();
    const owner = await env.DB.prepare('SELECT user_id FROM user_identities WHERE realm_id=? AND provider=? AND provider_id=?').bind(realm, provider, profile.providerId).first();
    invariant(owner?.user_id === user.id, 'access_denied', 'Account unavailable.', 403);
    // Admission was just decided with this sign-in's proof; record it, because the session's method alone (a provider
    // id) does not carry that proof when the authorization completes.
    if (client && allowed) await recordAdmission(env, client, user, email, proof);
    return user;
}
