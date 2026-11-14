// RFC 6238 TOTP: HMAC-SHA1, six digits, 30-second steps, one step of clock drift either way.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30, DIGITS = 6, WINDOW = 1;
export function base32(bytes) {
    let bits = 0, value = 0, out = '';
    for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}
export function fromBase32(text) {
    const clean = text.toUpperCase().replace(/[\s=-]/g, ''), out = [];
    let bits = 0, value = 0;
    for (const char of clean) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) throw new TypeError('Invalid base32.');
        value = (value << 5) | index; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
}
export const newSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);
export async function totpAt(secretBytes, step, digits = DIGITS) {
    const counter = new Uint8Array(8);
    for (let i = 7, s = step; i >= 0; i--, s = Math.floor(s / 256)) counter[i] = s & 255;
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter)), offset = mac[19] & 15;
    const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    return String(binary % 10 ** digits).padStart(digits, '0');
}
// Returns the matching step within the window, or null. The caller records it so a code is accepted once.
export async function matchingStep(secret, code, lastStep, now = Date.now()) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const bytes = fromBase32(secret), step = currentStep(now);
    for (const candidate of [step, step - 1, step + 1])
        if (candidate > lastStep && await totpAt(bytes, candidate) === code) return candidate;
    return null;
}
export const otpauthUri = ({ issuer, account, secret }) =>
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
