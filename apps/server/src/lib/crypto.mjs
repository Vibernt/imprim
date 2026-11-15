// Web Crypto primitives used across the identity protocol.
import { invariant } from './errors.mjs';
const encoder = new TextEncoder();
export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const from64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), x => x.charCodeAt(0));
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
export const challengeOf = async value => b64url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
// Compare fixed-length digests through Web Crypto's MAC verifier, without early-exit string comparison.
export async function safeEqual(a, b) {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(a));
    return crypto.subtle.verify('HMAC', key, mac, encoder.encode(b));
}
async function sealingKey(env, usage) {
    invariant(/^[a-f0-9]{64}$/i.test(env.SEALING_KEY || ''), 'key_config', 'SEALING_KEY must be 32 bytes encoded as hex.', 503);
    const bytes = Uint8Array.from(env.SEALING_KEY.match(/../g), x => parseInt(x, 16));
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage]);
}
export async function seal(env, value, aad) {
    const key = await sealingKey(env, 'encrypt'), iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(value));
    return JSON.stringify({ version: 1, iv: b64url(iv), ciphertext: b64url(data) });
}
export async function unseal(env, sealed, aad) {
    const key = await sealingKey(env, 'decrypt'), value = JSON.parse(sealed);
    invariant(value.version === 1, 'key_unavailable', 'Unsupported sealed key envelope.', 503);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(value.iv), additionalData: encoder.encode(aad) }, key, from64(value.ciphertext)));
}
