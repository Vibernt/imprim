// Second factors: policy per app, the gate in front of code issuance and agent consent, verification with replay
// protection, recovery codes and trusted browsers.
import { invariant } from '../lib/errors.mjs';
import { randomToken, sha256, seal, unseal } from '../lib/crypto.mjs';
import { cookies, cookie } from './session.mjs';
import { matchingStep, base32 } from './totp.mjs';
export const ACR_MFA = 'urn:imprim:acr:mfa', ACR_SINGLE = 'urn:imprim:acr:sf';
export const DEVICE_COOKIE = '__Host-vi_device', FRESH_MFA_MS = 600000, AGENT_MFA_MS = 900000, ADMIN_MFA_MS = 3600000;
const RECOVERY_CODES = 10;
// Authenticator apps and passkeys both count as second factors.
export async function confirmedFactors(env, userId) {
    return (await env.DB.prepare(`SELECT id,type,name,created,last_used FROM mfa_factors WHERE user_id=?1 AND confirmed=1
        UNION ALL SELECT id,'passkey',name,created,last_used FROM webauthn_credentials WHERE user_id=?1 ORDER BY created`).bind(userId).all()).results;
}
const acrRequested = row => (row?.acr_values || '').split(' ').includes(ACR_MFA);
// What this sign-in needs: 'none', 'verify' (has a factor) or 'enrol' (must add one first).
async function mfaNeed(env, { client, session, row, agent = false }) {
    const factors = await confirmedFactors(env, session.user_id);
    const policy = client.mfa === 'required' || acrRequested(row) || (agent && client.agent_consent_mfa === 'required')
        || (client.mfa === 'optional' && factors.length > 0);
    if (!policy) return 'none';
    const now = Date.now(), maxAgeMs = row?.max_age != null ? row.max_age * 1000 : null;
    const fresh = session.mfa_at && (!agent || client.agent_consent_mfa !== 'required' || session.mfa_at > now - AGENT_MFA_MS)
        && (maxAgeMs === null || session.mfa_at > now - maxAgeMs);
    if (fresh) return 'none';
    if (!factors.length) return 'enrol';
    return 'verify';
}
// A trusted browser stands in for the second factor only where the app allows it and nothing demands a real one.
async function trustedDevice(env, request, client, session, row, agent) {
    if (!client.mfa_trusted_device_days || acrRequested(row) || (agent && client.agent_consent_mfa === 'required')) return false;
    const token = cookies(request)[DEVICE_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const now = Date.now(), since = now - client.mfa_trusted_device_days * 86400000;
    const result = await env.DB.prepare('UPDATE trusted_devices SET last_used=? WHERE hash=? AND user_id=? AND client_id=? AND expires_at>? AND created>?')
        .bind(now, await sha256(token), session.user_id, client.id, now, since).run();
    return result.meta.changes === 1;
}
// null when the second factor is satisfied; otherwise where to send the person.
export async function mfaGate(env, request, { client, session, row, agent = false }) {
    const need = await mfaNeed(env, { client, session, row, agent });
    if (need === 'none' || await trustedDevice(env, request, client, session, row, agent)) return null;
    const query = new URLSearchParams({ request_id: row.id });
    return need === 'enrol' ? `/account/mfa?${query}` : `/mfa?${query}`;
}
// Marks the session as having passed a second factor now.
export function mfaStatement(env, session, amr) {
    const next = [...new Set([...JSON.parse(session.amr || '[]'), ...amr, 'mfa'])];
    return env.DB.prepare('UPDATE sessions SET mfa_at=?,amr=? WHERE hash=?').bind(Date.now(), JSON.stringify(next), session.hash);
}
// Verifies a TOTP or recovery code atomically: a code is accepted once, even under concurrent submission.
export async function verifySecondFactor(env, userId, input) {
    const code = typeof input === 'string' ? input.replace(/[\s-]/g, '') : '';
    if (/^\d{6}$/.test(code)) {
        const factors = (await env.DB.prepare("SELECT * FROM mfa_factors WHERE user_id=? AND confirmed=1 AND type='totp'").bind(userId).all()).results;
        for (const factor of factors) {
            const secret = await unseal(env, factor.sealed_secret, `totp:${factor.id}`);
            const step = await matchingStep(secret, code, factor.last_step);
            if (step === null) continue;
            const claimed = await env.DB.prepare('UPDATE mfa_factors SET last_step=?,last_used=? WHERE id=? AND last_step<?').bind(step, Date.now(), factor.id, step).run();
            if (claimed.meta.changes === 1) return { kind: 'totp', amr: ['otp'] };
        }
        return null;
    }
    if (/^[A-Z2-7]{10}$/i.test(code)) {
        const used = await env.DB.prepare('UPDATE recovery_codes SET used_at=? WHERE user_id=? AND hash=? AND used_at IS NULL')
            .bind(Date.now(), userId, await sha256(code.toUpperCase())).run();
        if (used.meta.changes === 1) return { kind: 'recovery', amr: ['otp'] };
    }
    return null;
}
export async function sealTotp(env, factorId, secret) { return seal(env, secret, `totp:${factorId}`); }
// New recovery codes replace the old set in one batch; the plaintext is shown once and never stored.
export async function recoveryStatements(env, userId) {
    const codes = Array.from({ length: RECOVERY_CODES }, () => base32(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10));
    const now = Date.now();
    const statements = [env.DB.prepare('DELETE FROM recovery_codes WHERE user_id=?').bind(userId)];
    for (const code of codes) statements.push(env.DB.prepare('INSERT INTO recovery_codes(user_id,hash,created) VALUES(?,?,?)').bind(userId, await sha256(code), now));
    return { codes: codes.map(code => `${code.slice(0, 5)}-${code.slice(5)}`), statements };
}
export async function trustBrowser(env, userId, clientId, days, request) {
    invariant(Number.isInteger(days) && days > 0, 'invalid_request', 'This app does not remember browsers.');
    const token = randomToken(), now = Date.now();
    const agent = (request.headers.get('user-agent') || 'Browser').replace(/[^\x20-\x7e]/g, '').slice(0, 60) || 'Browser';
    await env.DB.prepare('INSERT INTO trusted_devices(hash,user_id,client_id,name,created,last_used,expires_at) VALUES(?,?,?,?,?,?,?)')
        .bind(await sha256(token), userId, clientId, agent, now, now, now + days * 86400000).run();
    return cookie(DEVICE_COOKIE, token, days * 86400);
}
// Any password or factor change ends remembered browsers.
export const forgetDevices = (env, userId) => env.DB.prepare('DELETE FROM trusted_devices WHERE user_id=?').bind(userId);
