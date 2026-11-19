import { invariant } from '../lib/errors.mjs';
import { unseal } from '../lib/crypto.mjs';
import { qrSvg } from '../lib/qr.mjs';
import { confirmedFactors, sealTotp, recoveryStatements, mfaStatement, forgetDevices, FRESH_MFA_MS, hasFactorSql, clearOrphanedRecovery } from '../auth/mfa.mjs';
import { newSecret, matchingStep, otpauthUri } from '../auth/totp.mjs';
import { credentials } from '../webauthn/ceremonies.mjs';
import { notify } from '../services/notify.mjs';
import { t } from '../i18n/index.mjs';
import { requireChange, writeGuardFailed } from './write-guard.mjs';

const FRESH_AUTH_MS = 600000;
const unusedCodes = 'SELECT count(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL';
const audit = (env, event, userId, detail = {}) => env.DB.prepare('INSERT INTO audit(event,actor,detail,created,realm_id) VALUES(?,?,?,?,?)').bind(event, userId, JSON.stringify(detail), Date.now(), env.REALM.id);

export function requireVerifiedFactorEmail(session) {
    invariant(session.email_verified === 1, 'access_denied', 'Confirm your email with a sign-in link first.', 403);
}

export async function readFactors(env, session) {
    const userId = session.user_id;
    const [all, passkeys, left] = await Promise.all([
        confirmedFactors(env, userId), credentials(env, userId), env.DB.prepare(unusedCodes).bind(userId).first()
    ]);
    return { factors: all.filter(factor => factor.type === 'totp'), passkeys, recovery_count: left.n };
}

export async function changeFactor(env, ctx, session, action, values) {
    requireVerifiedFactorEmail(session);
    const now = Date.now(), freshMfa = session.mfa_at && session.mfa_at > now - FRESH_MFA_MS;
    const factors = await confirmedFactors(env, session.user_id);
    if (['start', 'confirm'].includes(action) && factors.length)
        invariant(freshMfa, 'mfa_required', 'Enter a code from your current authenticator at /mfa?next=/account/mfa first (within ten minutes).', 403);
    if (action === 'start') return startTotp(env, session, now, freshMfa);
    if (action === 'confirm') return confirmTotp(env, ctx, session, values, now);
    invariant(freshMfa, 'mfa_required', 'Enter a code at /mfa?next=/account/mfa first (within ten minutes).', 403);
    if (action === 'remove') return removeTotp(env, ctx, session, factors, values.factor_id);
    invariant(action === 'recovery', 'invalid_request', 'Unknown action.');
    invariant(factors.length, 'invalid_request', 'Add a second factor first.');
    return regenerateRecovery(env, ctx, session);
}

async function startTotp(env, session, now, freshMfa) {
    invariant(session.auth_time * 1000 > now - FRESH_AUTH_MS || freshMfa, 'reauth_required', 'Sign in again (within ten minutes) before adding a second factor.', 403);
    const factor_id = crypto.randomUUID(), secret = newSecret();
    const name = t(env, 'Authenticator app');
    const uri = otpauthUri({ issuer: env.REALM.display_name, account: session.email, secret });
    const qr = qrSvg(uri, { label: t(env, 'Authenticator setup code') });
    await env.DB.batch([
        env.DB.prepare('DELETE FROM mfa_factors WHERE user_id=? AND confirmed=0').bind(session.user_id),
        env.DB.prepare('INSERT INTO mfa_factors(id,user_id,type,name,sealed_secret,created) VALUES(?,?,?,?,?,?)')
            .bind(factor_id, session.user_id, 'totp', name, await sealTotp(env, factor_id, secret), now)
    ]);
    return { factor_id, name, secret: secret.match(/.{1,4}/g).join(' '), qr };
}

async function confirmTotp(env, ctx, session, values, now) {
    const userId = session.user_id, expires = now - 3600000;
    invariant(typeof values.factor_id === 'string' && /^[0-9a-f-]{36}$/.test(values.factor_id), 'invalid_request', 'Start again: that setup expired.', 400);
    const factor = await env.DB.prepare('SELECT id,confirmed,created,sealed_secret FROM mfa_factors WHERE id=? AND user_id=?').bind(values.factor_id, userId).first();
    invariant(factor, 'not_found', 'Factor not found.', 404);
    invariant(!factor.confirmed && factor.created > expires, 'invalid_request', 'Start again: that setup expired.', 400);
    const step = await matchingStep(await unseal(env, factor.sealed_secret, `totp:${factor.id}`), values.code, -1);
    invariant(step !== null, 'invalid_grant', 'That code did not match. Check the time on your phone and try the newest code.', 400);
    const name = typeof values.name === 'string' && values.name.trim() ? values.name.trim().slice(0, 60) : t(env, 'Authenticator app');
    const { n: unused } = await env.DB.prepare(unusedCodes).bind(userId).first();
    const recovery = unused ? { codes: [], statements: [] } : await recoveryStatements(env, userId);
    // Claim the pending setup exactly once and preserve a recovery set another factor just created.
    try {
        await env.DB.batch([
            env.DB.prepare(`UPDATE mfa_factors SET confirmed=1,last_step=?,name=?,last_used=? WHERE id=? AND user_id=? AND confirmed=0 AND created>?
                AND (? OR (${unusedCodes})=0)`).bind(step, name, now, factor.id, userId, expires, unused ? 1 : 0, userId),
            requireChange(env), ...recovery.statements, mfaStatement(env, session, ['otp']), forgetDevices(env, userId),
            audit(env, 'mfa_factor_added', userId, { type: 'totp' })
        ]);
    } catch (error) {
        if (!writeGuardFailed(error)) throw error;
        invariant(false, 'conflict', 'The second-factor setup changed. Reload the page and try again.', 409);
    }
    notify(env, ctx, session.email, 'factor_added', { name });
    return { recovery_codes: recovery.codes };
}

async function removeTotp(env, ctx, session, factors, id) {
    invariant(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'invalid_request', 'Choose an authenticator app to remove.');
    const factor = factors.find(row => row.id === id && row.type === 'totp');
    invariant(factor, 'not_found', 'Factor not found.', 404);
    try {
        await env.DB.batch([env.DB.prepare('DELETE FROM mfa_factors WHERE id=? AND user_id=? AND confirmed=1').bind(id, session.user_id),
            requireChange(env), clearOrphanedRecovery(env, session.user_id), forgetDevices(env, session.user_id),
            audit(env, 'mfa_factor_removed', session.user_id, { type: factor.type })]);
    } catch (error) {
        if (!writeGuardFailed(error)) throw error;
        invariant(false, 'not_found', 'Factor not found.', 404);
    }
    notify(env, ctx, session.email, 'factor_removed', { name: factor.name });
    return {};
}

async function regenerateRecovery(env, ctx, session) {
    const recovery = await recoveryStatements(env, session.user_id);
    try {
        await env.DB.batch([env.DB.prepare(`INSERT INTO admin_assertions(ok) VALUES((${hasFactorSql}))`).bind(session.user_id),
            ...recovery.statements, audit(env, 'recovery_codes_regenerated', session.user_id)]);
    } catch (error) {
        if (!writeGuardFailed(error)) throw error;
        invariant(false, 'invalid_request', 'Add a second factor first.');
    }
    notify(env, ctx, session.email, 'recovery_codes_regenerated');
    return { recovery_codes: recovery.codes };
}
