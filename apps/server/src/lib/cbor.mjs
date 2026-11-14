// Minimal CBOR decoder (RFC 8949) for WebAuthn: unsigned and negative integers, byte and text strings, arrays,
// maps, simple values. Definite lengths only; anything else is refused. Returns [value, nextOffset].
export function decodeCbor(bytes, offset = 0, depth = 0) {
    if (depth > 16) throw new TypeError('CBOR nesting too deep.');
    if (offset >= bytes.length) throw new TypeError('CBOR truncated.');
    const head = bytes[offset], major = head >> 5, info = head & 31;
    let length, at = offset + 1;
    const read = n => { if (at + n > bytes.length) throw new TypeError('CBOR truncated.'); let v = 0; for (let i = 0; i < n; i++) v = v * 256 + bytes[at + i]; at += n; return v; };
    if (info < 24) length = info;
    else if (info === 24) length = read(1); else if (info === 25) length = read(2); else if (info === 26) length = read(4); else if (info === 27) length = read(8);
    else throw new TypeError('Indefinite or reserved CBOR length.');
    if (!Number.isSafeInteger(length)) throw new TypeError('CBOR length too large.');
    switch (major) {
        case 0: return [length, at];
        case 1: return [-1 - length, at];
        case 2: case 3: {
            if (at + length > bytes.length) throw new TypeError('CBOR truncated.');
            const slice = bytes.slice(at, at + length);
            return [major === 2 ? slice : new TextDecoder('utf-8', { fatal: true }).decode(slice), at + length];
        }
        case 4: { const out = []; for (let i = 0; i < length; i++) { const [v, next] = decodeCbor(bytes, at, depth + 1); out.push(v); at = next; } return [out, at]; }
        case 5: {
            const out = new Map();
            for (let i = 0; i < length; i++) {
                const [k, a] = decodeCbor(bytes, at, depth + 1), [v, b] = decodeCbor(bytes, a, depth + 1);
                if (out.has(k)) throw new TypeError('Duplicate CBOR map key.');
                out.set(k, v); at = b;
            }
            return [out, at];
        }
        case 7: if (info === 20) return [false, at]; if (info === 21) return [true, at]; if (info === 22) return [null, at]; throw new TypeError('Unsupported CBOR simple value.');
        default: throw new TypeError('Unsupported CBOR type.');
    }
}
