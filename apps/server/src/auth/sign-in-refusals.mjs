import { sha256 } from '../lib/crypto.mjs';
import { AppError } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';

export function signInRefusal(reason, email) {
    return Object.assign(new AppError(403, 'access_denied', 'Account unavailable.'), { signInReason: reason, signInEmail: email });
}

export async function recordSignInRefusal(env, reason, { method, clientId = null, email = null, audit = false }) {
    const address = email?.toLowerCase();
    const detail = { reason, method, client_id: clientId,
        email: address ? `${[...address][0]}***@${address.split('@')[1]}` : null,
        email_hash: address ? await sha256(address) : null };
    console.log(JSON.stringify({ type: 'sign_in_refused', ...detail, realm_id: realmId(env) }));
    if (audit && !['rate_limited', 'turnstile_failed', 'invalid_credentials'].includes(reason)) {
        await env.DB.prepare("INSERT INTO audit(event,actor,target,detail,created,realm_id) VALUES('sign_in_refused',NULL,?,?,?,?)")
            .bind(clientId, JSON.stringify(detail), Date.now(), realmId(env)).run();
    }
}

const methods = new Map([
    ['POST /v1/auth/magic/request', 'email'], ['POST /v1/auth/magic/verify', 'email'],
    ['POST /v1/auth/password', 'password'], ['POST /v1/auth/passkey/options', 'passkey'],
    ['POST /v1/auth/passkey/verify', 'passkey'], ['GET /auth/github/callback', 'github'],
    ['GET /login/google/callback', 'google'], ['GET /v1/auth/github/start', 'github'],
    ['GET /v1/auth/google/start', 'google'], ['POST /v1/auth/github/signup', 'github'],
    ['POST /v1/auth/google/signup', 'google']
]);

export function signInAttempt(method, path) {
    const provider = (method === 'GET' || method === 'POST') &&
        /^\/login\/provider\/([a-z][a-z0-9-]{1,39})\/callback$/.exec(path) ||
        method === 'GET' && /^\/v1\/auth\/provider\/([a-z][a-z0-9-]{1,39})\/start$/.exec(path);
    const kind = methods.get(`${method} ${path}`) ?? provider?.[1];
    return kind ? { method: kind, emailRequest: path === '/v1/auth/magic/request' } : null;
}

export async function reportSignInRefusal(env, reason, email) {
    const attempt = env.SIGN_IN_ATTEMPT;
    if (!attempt || attempt.reported) return;
    attempt.reported = true;
    await recordSignInRefusal(env, reason, { ...attempt, email: email ?? attempt.email });
}

export async function reportSignInError(env, error) {
    const attempt = env.SIGN_IN_ATTEMPT;
    if (!attempt || attempt.reported) return;
    const reason = error.signInReason ?? (error.code === 'rate_limit' ? 'rate_limited' :
        error.code?.startsWith('turnstile_') ? 'turnstile_failed' :
        attempt.emailRequest ? 'link_skipped' : 'account_unavailable');
    // Protocol validation errors and outages still leave a log. Audit classified outcomes after the relevant checks.
    if (!error.signInReason && !attempt.emailRequest) attempt.audit = false;
    await reportSignInRefusal(env, reason, error.signInEmail);
}
