// WebAuthn Level 2 verification for registration (attestation "none": no attestation trust is claimed) and
// authentication. Every check is explicit; any failure throws invalid_grant.
import { decodeCbor } from '../lib/cbor.mjs';
import { b64url, from64 } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
const fail = message => invariant(false, 'invalid_grant', message, 400);
const sha = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const decode = value => { try { return from64(value); } catch { fail('Malformed WebAuthn field.'); } };
export const FLAGS = { UP: 1, UV: 4, BE: 8, BS: 16, AT: 64, ED: 128 };
// COSE_Key to Web Crypto: ES256 (P-256), RS256 and EdDSA (Ed25519).
export function coseToJwk(cose) {
    invariant(cose instanceof Map, 'invalid_grant', 'Invalid credential public key.', 400);
    const kty = cose.get(1), alg = cose.get(3), bytes = key => { const v = cose.get(key); if (!(v instanceof Uint8Array)) fail('Invalid credential public key.'); return b64url(v); };
    if (kty === 2 && alg === -7 && cose.get(-1) === 1) return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) } };
    if (kty === 3 && alg === -257) return { alg: -257, jwk: { kty: 'RSA', n: bytes(-1), e: bytes(-2) } };
    if (kty === 1 && alg === -8 && cose.get(-1) === 6) return { alg: -8, jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) } };
    fail('Unsupported credential algorithm. Use ES256, RS256 or Ed25519.');
}
function parseAuthData(data, expectCredential) {
    if (data.length < 37) fail('Authenticator data too short.');
    const flags = data[32], counter = new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0);
    const parsed = { rpIdHash: data.slice(0, 32), flags, counter };
    if (expectCredential) {
        if (!(flags & FLAGS.AT) || data.length < 55) fail('No attested credential data.');
        const idLength = (data[53] << 8) | data[54];
        if (idLength < 16 || idLength > 1023 || data.length < 55 + idLength) fail('Invalid credential id.');
        parsed.credentialId = data.slice(55, 55 + idLength);
        const [cose, end] = decodeCbor(data, 55 + idLength);
        if (end !== data.length && !(flags & FLAGS.ED)) fail('Trailing authenticator data.');
        parsed.publicKey = coseToJwk(cose);
    }
    return parsed;
}
async function clientData(json, type, challenge, origin) {
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)); } catch { fail('Malformed client data.'); }
    if (data?.type !== type) fail('Wrong WebAuthn ceremony type.');
    if (typeof data.challenge !== 'string' || data.challenge !== challenge) fail('WebAuthn challenge mismatch.');
    if (data.origin !== origin) fail('WebAuthn origin mismatch.');
    if (data.crossOrigin === true) fail('Cross-origin WebAuthn is not accepted.');
}
async function checkRp(parsed, rpId, requireUv) {
    if (!equal(parsed.rpIdHash, await sha(new TextEncoder().encode(rpId)))) fail('WebAuthn RP ID mismatch.');
    if (!(parsed.flags & FLAGS.UP)) fail('User presence is required.');
    if (requireUv && !(parsed.flags & FLAGS.UV)) fail('User verification (PIN or biometric) is required.');
}
export async function verifyRegistration({ clientDataJSON, attestationObject }, { challenge, origin, rpId }) {
    const json = decode(clientDataJSON);
    await clientData(json, 'webauthn.create', challenge, origin);
    let attestation;
    try { [attestation] = decodeCbor(decode(attestationObject)); } catch { fail('Malformed attestation object.'); }
    if (!(attestation instanceof Map) || !(attestation.get('authData') instanceof Uint8Array)) fail('Malformed attestation object.');
    const parsed = parseAuthData(attestation.get('authData'), true);
    await checkRp(parsed, rpId, true);
    return { credentialId: b64url(parsed.credentialId), publicKey: parsed.publicKey, counter: parsed.counter,
        backupEligible: Boolean(parsed.flags & FLAGS.BE) };
}
// DER ECDSA signature to the raw r||s form Web Crypto verifies.
function derToRaw(der) {
    if (der[0] !== 0x30) fail('Malformed signature.');
    let at = 2;
    const part = () => { if (der[at] !== 0x02) fail('Malformed signature.'); const length = der[at + 1]; let value = der.slice(at + 2, at + 2 + length); at += 2 + length;
        while (value.length > 32 && value[0] === 0) value = value.slice(1); if (value.length > 32) fail('Malformed signature.');
        const out = new Uint8Array(32); out.set(value, 32 - value.length); return out; };
    const r = part(), s = part(), raw = new Uint8Array(64); raw.set(r); raw.set(s, 32);
    return raw;
}
const algorithms = { [-7]: [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }], [-257]: [{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, { name: 'RSASSA-PKCS1-v1_5' }], [-8]: [{ name: 'Ed25519' }, { name: 'Ed25519' }] };
export async function verifyAssertion({ clientDataJSON, authenticatorData, signature }, credential, { challenge, origin, rpId, requireUv = true }) {
    const json = decode(clientDataJSON), auth = decode(authenticatorData), sig = decode(signature);
    await clientData(json, 'webauthn.get', challenge, origin);
    const parsed = parseAuthData(auth, false);
    await checkRp(parsed, rpId, requireUv);
    const [importAlg, verifyAlg] = algorithms[credential.alg] ?? fail('Unsupported credential algorithm.');
    const signed = new Uint8Array(auth.length + 32); signed.set(auth); signed.set(await sha(json), auth.length);
    let valid = false;
    try {
        const key = await crypto.subtle.importKey('jwk', JSON.parse(credential.public_key), importAlg, false, ['verify']);
        valid = await crypto.subtle.verify(verifyAlg, key, credential.alg === -7 ? derToRaw(sig) : sig, signed);
    } catch (error) { if (error?.code) throw error; fail('Invalid passkey signature.'); }
    if (!valid) fail('Invalid passkey signature.');
    // A counter that does not move forward means a cloned authenticator; zero means the authenticator has none.
    if ((parsed.counter !== 0 || credential.sign_count !== 0) && parsed.counter <= credential.sign_count) fail('This passkey reported an old signature counter. Remove it and add it again.');
    return { counter: parsed.counter, uv: Boolean(parsed.flags & FLAGS.UV), backupEligible: Boolean(parsed.flags & FLAGS.BE) };
}
