import { publicKey } from '../agents/client-auth.mjs';
import { invariant } from '../lib/errors.mjs';

const privateMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

export function serviceKeys(jwks) {
    invariant(Array.isArray(jwks?.keys) && jwks.keys.length >= 1 && jwks.keys.length <= 5,
        'invalid_request', 'jwks needs 1 to 5 public keys.');
    let keys;
    try {
        keys = jwks.keys.map(key => {
            const publicJwk = publicKey(key);
            if (privateMembers.some(member => Object.hasOwn(key, member))) throw new Error('Public JWK required');
            return publicJwk;
        });
    } catch {
        invariant(false, 'invalid_request', 'Each key needs a kid and must be a public P-256 or RSA-2048+ key.');
    }
    invariant(new Set(keys.map(key => key.kid)).size === keys.length, 'invalid_request', 'Key ids must be distinct.');
    return { keys };
}
