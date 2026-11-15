// PBKDF2-SHA256 through Web Crypto. 100,000 iterations is the most Cloudflare Workers allow; the algorithm and
// parameters are stored per hash, so a stronger scheme can replace a hash at the next successful sign-in.
import { b64url, from64, safeEqual } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
const PASSWORD_ITERATIONS = 100000;
const encoder = new TextEncoder(), DUMMY_SALT = new Uint8Array(16);
async function derive(password, salt, iterations) {
    // NFKC so the same password typed on different keyboards or platforms derives the same key (NIST SP 800-63B).
    const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return { algorithm: 'pbkdf2-sha256', iterations: PASSWORD_ITERATIONS, salt: b64url(salt), hash: await derive(password, salt, PASSWORD_ITERATIONS) };
}
// Without a stored hash, the same derivation still runs, so timing does not reveal whether an account has a password.
export async function verifyPassword(password, row) {
    if (!row) { await derive(password, DUMMY_SALT, PASSWORD_ITERATIONS); return false; }
    invariant(row.algorithm === 'pbkdf2-sha256', 'password_config', 'Unsupported password hash.', 503);
    return safeEqual(await derive(password, from64(row.salt), row.iterations), row.hash);
}
export const needsRehash = row => row.algorithm !== 'pbkdf2-sha256' || row.iterations < PASSWORD_ITERATIONS;
