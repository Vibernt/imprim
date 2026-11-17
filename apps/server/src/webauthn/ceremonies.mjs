// Passkey ceremonies. Challenges are single-use and bound to the browser that asked; credentials are realm-scoped
// (the RP ID is the realm's host) and user verification (PIN or biometric) is always required.
import { t } from '../i18n/index.mjs';
import { readBody, json, tokenShape, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256, b64url, from64 } from '../lib/crypto.mjs';
import { cookies, BROWSER_COOKIE, getSession, requireCsrf, assertOrigin, issueSession, sessionByHash } from '../auth/session.mjs';
import { verifyRegistration, verifyAssertion } from './verify.mjs';
import { pendingRequest, completeAuthorization } from '../oidc/requests.mjs';
import { requireMethod } from '../oidc/sign-in-methods.mjs';
import { admitted, isAdmin } from '../services/admission.mjs';
import { confirmedFactors, mfaStatement, forgetDevices, recoveryStatements, FRESH_MFA_MS } from '../auth/mfa.mjs';
import { safeNext } from '../auth/mfa-challenge.mjs';
import { attempt, clearFailures, mfaFailureKey } from '../auth/rate-limit.mjs';
import { audit } from '../services/audit.mjs';
import { notify } from '../services/notify.mjs';
import { realmId } from '../realms/realm.mjs';
const CHALLENGE_MS = 300000, FRESH_AUTH_MS = 600000;
const rp = env => ({ id: new URL(env.ISSUER).hostname, origin: env.ISSUER, name: env.REALM.display_name });
const browserHash = async request => {
    const browser = cookies(request)[BROWSER_COOKIE];
    invariant(tokenShape(browser), 'browser_binding', 'Reload the page and try again.', 403);
    return sha256(browser);
};
async function newChallenge(env, request, purpose, { userId = null, requestId = null } = {}) {
    const challenge = randomToken();
    await env.DB.prepare('INSERT INTO webauthn_challenges(hash,purpose,user_id,request_id,browser_hash,expires_at) VALUES(?,?,?,?,?,?)')
        .bind(await sha256(challenge), purpose, userId, requestId, await browserHash(request), Date.now() + CHALLENGE_MS).run();
    return challenge;
}
// Reads the challenge the authenticator signed and claims it once, for this purpose and browser.
async function claimChallenge(env, request, purpose, clientDataJSON) {
    let challenge;
    try { challenge = JSON.parse(new TextDecoder().decode(from64(clientDataJSON))).challenge; } catch { invariant(false, 'invalid_grant', 'Malformed client data.', 400); }
    invariant(tokenShape(challenge), 'invalid_grant', 'Malformed challenge.', 400);
    const row = await env.DB.prepare('DELETE FROM webauthn_challenges WHERE hash=? AND purpose=? AND browser_hash=? AND expires_at>? RETURNING *')
        .bind(await sha256(challenge), purpose, await browserHash(request), Date.now()).first();
    invariant(row, 'invalid_grant', 'This passkey request expired or was already used. Try again.', 400);
    return { challenge, row };
}
const amrFor = backupEligible => [backupEligible ? 'swk' : 'hwk', 'user'];
export const credentials = (env, userId) => env.DB.prepare('SELECT id,name,created,last_used,backup_eligible FROM webauthn_credentials WHERE user_id=? AND realm_id=? ORDER BY created').bind(userId, realmId(env)).all().then(r => r.results);
// Registration: from a signed-in session, with the same freshness as adding any second factor.
export async function registrationOptions(request, env) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    const body = await readBody(request);
    await requireCsrf(request, env, session, body.csrf);
    invariant(session.email_verified === 1, 'access_denied', 'Confirm your email with a sign-in link first.', 403);
    const now = Date.now(), factors = await confirmedFactors(env, session.user_id);
    if (factors.length) invariant(session.mfa_at && session.mfa_at > now - FRESH_MFA_MS, 'mfa_required', 'Confirm with your current second factor at /mfa?next=/account/mfa first.', 403);
    else invariant(session.auth_time * 1000 > now - FRESH_AUTH_MS, 'reauth_required', 'Sign in again (within ten minutes) first.', 403);
    const challenge = await newChallenge(env, request, 'register', { userId: session.user_id }), party = rp(env);
    return json({ publicKey: { challenge, rp: { id: party.id, name: party.name },
        user: { id: b64url(new TextEncoder().encode(session.user_id)), name: session.email, displayName: session.display_name || session.email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, attestation: 'none', timeout: CHALLENGE_MS,
        excludeCredentials: (await credentials(env, session.user_id)).map(c => ({ type: 'public-key', id: c.id })) } });
}
export async function register(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    const body = await readBody(request);
    await requireCsrf(request, env, session, body.csrf);
    const { challenge, row } = await claimChallenge(env, request, 'register', body.clientDataJSON);
    invariant(row.user_id === session.user_id, 'invalid_grant', 'This passkey request belongs to another session.', 400);
    const party = rp(env), result = await verifyRegistration(body, { challenge, origin: party.origin, rpId: party.id });
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : t(env, 'Passkey');
    // Whatever the first factor is, the person gets recovery codes with it (shown once).
    const unused = (await env.DB.prepare('SELECT count(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL').bind(session.user_id).first()).n;
    const recovery = unused ? { codes: [], statements: [] } : await recoveryStatements(env, session.user_id);
    try {
        await env.DB.batch([...recovery.statements,
            env.DB.prepare('INSERT INTO webauthn_credentials(id,realm_id,user_id,public_key,alg,sign_count,backup_eligible,name,created) VALUES(?,?,?,?,?,?,?,?,?)')
                .bind(result.credentialId, realmId(env), session.user_id, JSON.stringify(result.publicKey.jwk), result.publicKey.alg, result.counter, result.backupEligible ? 1 : 0, name, Date.now()),
            mfaStatement(env, session, amrFor(result.backupEligible)), forgetDevices(env, session.user_id),
            env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES('passkey_added',?,'{}',?,?)").bind(session.user_id, Date.now(), env.REALM.id)]);
    } catch (error) {
        invariant(!String(error.message).includes('UNIQUE'), 'conflict', 'This passkey is already registered.', 409);
        throw error;
    }
    notify(env, ctx, session.email, 'passkey_added', { name });
    return json({ added: true, name, recovery_codes: recovery.codes });
}
// Sign-in (purpose 'login', discoverable credentials, from an app that offers passkeys) or second factor ('mfa').
export async function assertionOptions(request, env) {
    assertOrigin(request, env);
    const body = await readBody(request), party = rp(env);
    if (body.purpose === 'mfa') {
        const session = await getSession(request, env);
        invariant(session, 'login_required', 'Sign in first.', 401);
        await requireCsrf(request, env, session, body.csrf);
        const allow = (await credentials(env, session.user_id)).map(c => ({ type: 'public-key', id: c.id }));
        invariant(allow.length, 'invalid_request', 'You have no passkeys.');
        invariant(body.request_id === undefined || (typeof body.request_id === 'string' && body.request_id.length <= 100), 'invalid_request', 'Invalid request id.');
        const challenge = await newChallenge(env, request, 'mfa', { userId: session.user_id, requestId: body.request_id || null });
        return json({ publicKey: { challenge, rpId: party.id, userVerification: 'required', timeout: CHALLENGE_MS, allowCredentials: allow } });
    }
    invariant(typeof body.request_id === 'string' && body.request_id.length <= 100, 'invalid_request', 'Passkey sign-in starts from an app.');
    const pending = await pendingRequest(env, request, body.request_id);
    requireMethod(pending.client, 'passkey');
    const challenge = await newChallenge(env, request, 'login', { requestId: pending.row.id });
    return json({ publicKey: { challenge, rpId: party.id, userVerification: 'required', timeout: CHALLENGE_MS, allowCredentials: [] } });
}
async function useCredential(env, body, userId = null) {
    invariant(typeof body.id === 'string' && /^[A-Za-z0-9_-]{16,1400}$/.test(body.id), 'invalid_grant', 'Unknown passkey.', 400);
    const credential = await env.DB.prepare('SELECT * FROM webauthn_credentials WHERE id=? AND realm_id=?').bind(body.id, realmId(env)).first();
    invariant(credential && (!userId || credential.user_id === userId), 'invalid_grant', 'This passkey is not registered for this account.', 400);
    if (body.userHandle) invariant(body.userHandle === b64url(new TextEncoder().encode(credential.user_id)), 'invalid_grant', 'Passkey user mismatch.', 400);
    return credential;
}
export async function assertionVerify(request, env, ctx) {
    assertOrigin(request, env);
    const body = await readBody(request), party = rp(env);
    const purpose = body.purpose === 'mfa' ? 'mfa' : 'login';
    let session = null;
    if (purpose === 'mfa') {
        session = await getSession(request, env);
        invariant(session, 'login_required', 'Sign in first.', 401);
        await requireCsrf(request, env, session, body.csrf);
        invariant(await attempt(env, mfaFailureKey(session.user_id)), 'rate_limit', 'Too many attempts. Wait fifteen minutes.', 429);
    }
    const { challenge, row } = await claimChallenge(env, request, purpose, body.clientDataJSON);
    if (purpose === 'mfa') invariant(row.user_id === session.user_id, 'invalid_grant', 'This passkey request belongs to another session.', 400);
    // Discoverable sign-in identifies the account by the authenticator's userHandle, which must be present (§7.2 step 6).
    if (purpose === 'login') invariant(typeof body.userHandle === 'string' && body.userHandle, 'invalid_grant', 'This passkey did not identify an account.', 400);
    const credential = await useCredential(env, body, session?.user_id);
    const result = await verifyAssertion(body, credential, { challenge, origin: party.origin, rpId: party.id });
    // The counter moves forward atomically: a concurrent replay of the same assertion loses.
    const moved = await env.DB.prepare('UPDATE webauthn_credentials SET sign_count=?,last_used=? WHERE id=? AND sign_count=?').bind(result.counter, Date.now(), credential.id, credential.sign_count).run();
    invariant(moved.meta.changes === 1, 'invalid_grant', 'This passkey was just used. Try again.', 400);
    const amr = amrFor(result.backupEligible);
    if (purpose === 'mfa') {
        await clearFailures(env, mfaFailureKey(session.user_id));
        await env.DB.batch([mfaStatement(env, session, amr), env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES('mfa_verified',?,'{\"type\":\"passkey\"}',?,?)").bind(session.user_id, Date.now(), env.REALM.id)]);
        const current = await sessionByHash(env, session.hash);
        if (row.request_id) {
            const pending = await pendingRequest(env, request, row.request_id);
            const response = await completeAuthorization(env, request, pending.row.id, current);
            return json({ redirect: response.headers.get('location') });
        }
        return json({ redirect: `${env.ISSUER}${safeNext(body.next)}` });
    }
    // Passwordless sign-in: the passkey with user verification is possession plus PIN or biometric, so it also
    // satisfies a second-factor policy.
    const pending = await pendingRequest(env, request, row.request_id);
    requireMethod(pending.client, 'passkey');
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=? AND realm_id=? AND status='active' AND merged_into IS NULL").bind(credential.user_id, realmId(env)).first();
    invariant(user && !await isAdmin(env, user.email), 'access_denied', 'Account unavailable.', 403);
    invariant(await admitted(env, pending.client, user.email, 'provider'), 'access_denied', 'Account unavailable.', 403);
    const signed = await issueSession(env, user, 'passkey');
    await env.DB.prepare('UPDATE sessions SET mfa_at=?,amr=? WHERE hash=?').bind(Date.now(), JSON.stringify([...amr, 'mfa']), signed.session.hash).run();
    await audit(env, 'sign_in', user.id, { method: 'passkey' });
    const response = await completeAuthorization(env, request, pending.row.id, await sessionByHash(env, signed.session.hash), signed.cookies);
    const result2 = json({ redirect: response.headers.get('location') });
    for (const value of response.headers.getSetCookie()) result2.headers.append('set-cookie', value);
    return result2;
}
export async function removePasskey(request, env, ctx) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    const body = await readBody(request, 'form');
    await requireCsrf(request, env, session, body.csrf);
    invariant(session.mfa_at && session.mfa_at > Date.now() - FRESH_MFA_MS, 'mfa_required', 'Enter a second factor at /mfa?next=/account/mfa first (within ten minutes).', 403);
    const gone = await env.DB.prepare('DELETE FROM webauthn_credentials WHERE id=? AND user_id=? AND realm_id=? RETURNING name').bind(body.id || '', session.user_id, realmId(env)).first();
    invariant(gone, 'not_found', 'Passkey not found.', 404);
    // The last factor gone takes the recovery codes with it, so old codes never return with a new factor.
    const remaining = (await confirmedFactors(env, session.user_id)).length;
    await env.DB.batch([forgetDevices(env, session.user_id), ...(remaining ? [] : [env.DB.prepare('DELETE FROM recovery_codes WHERE user_id=?').bind(session.user_id)]),
        env.DB.prepare("INSERT INTO audit(event,actor,detail,created,realm_id) VALUES('passkey_removed',?,'{}',?,?)").bind(session.user_id, Date.now(), env.REALM.id)]);
    notify(env, ctx, session.email, 'passkey_removed', { name: gone.name });
    return redirect(`${env.ISSUER}/account/mfa`);
}
