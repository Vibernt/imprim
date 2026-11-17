// A software authenticator for tests: ES256 keys, attestation "none", discoverable credentials, user verification.
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const sha = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
function cbor(value) {
    const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : n < 65536 ? [major << 5 | 25, n >> 8, n & 255] : [major << 5 | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
    if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
    if (typeof value === 'string') { const bytes = new TextEncoder().encode(value); return [...head(3, bytes.length), ...bytes]; }
    if (value instanceof Map) return [...head(5, value.size), ...[...value].flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
    throw new TypeError('unsupported');
}
function rawToDer(raw) {
    const part = bytes => { let v = [...bytes]; while (v.length > 1 && v[0] === 0 && v[1] < 128) v.shift(); if (v[0] >= 128) v.unshift(0); return [0x02, v.length, ...v]; };
    const body = [...part(raw.slice(0, 32)), ...part(raw.slice(32))];
    return new Uint8Array([0x30, body.length, ...body]);
}
export async function authenticator({ rpId = 'id.example.com', origin = 'https://id.example.com', backupEligible = true } = {}) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const id = crypto.getRandomValues(new Uint8Array(32));
    let counter = 0, userHandle = null;
    const flags = (uv = true) => 0x01 | (uv ? 0x04 : 0) | (backupEligible ? 0x08 : 0);
    const counterBytes = n => new Uint8Array([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
    return {
        id: b64(id),
        async create(options, { uv = true, originOverride, rpOverride, type = 'webauthn.create', fmt = 'none', trailing = [] } = {}) {
            userHandle = options.user.id;
            const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]);
            const authData = new Uint8Array([...await sha(new TextEncoder().encode(rpOverride || rpId)), flags(uv) | 0x40, ...counterBytes(counter), ...new Uint8Array(16), 0, id.length, ...id, ...cbor(cose), ...trailing]);
            const clientData = new TextEncoder().encode(JSON.stringify({ type, challenge: options.challenge, origin: originOverride || origin }));
            return { clientDataJSON: b64(clientData), attestationObject: b64(new Uint8Array(cbor(new Map([['fmt', fmt], ['attStmt', new Map()], ['authData', authData]])))) };
        },
        async get(options, { uv = true, counterOverride, originOverride } = {}) {
            counter = counterOverride ?? counter + 1;
            const authData = new Uint8Array([...await sha(new TextEncoder().encode(rpId)), flags(uv), ...counterBytes(counter)]);
            const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: originOverride || origin }));
            const signed = new Uint8Array([...authData, ...await sha(clientData)]);
            const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed));
            return { id: b64(id), clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(rawToDer(raw)), userHandle: userHandle ?? undefined };
        }
    };
}
