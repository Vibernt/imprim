// NIST SP 800-63B: length, a breached-password check (breach.mjs), and no composition rules.
import { invariant } from '../lib/errors.mjs';
export const MIN_PASSWORD = 12, MAX_PASSWORD = 128;
export function validatePassword(password, email) {
    invariant(typeof password === 'string', 'invalid_request', 'A password is required.');
    const length = [...password].length;
    invariant(length >= MIN_PASSWORD && length <= MAX_PASSWORD, 'weak_password', 'Use {min} to {max} characters. Long passphrases are best.', 400, { min: MIN_PASSWORD, max: MAX_PASSWORD });
    invariant(password.trim().toLowerCase() !== email.toLowerCase(), 'weak_password', 'Do not use your email address as your password.');
    invariant(new Set(password).size > 3, 'weak_password', 'That password repeats too few characters.');
    return password;
}
