import { thumbprint } from '../../apps/server/src/machines/dpop.mjs';

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export const ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export async function keyPair(kid = 'm1') {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { ...pair, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid } };
}
export async function assertion(pair, clientId, claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'ES256', kid: pair.jwk.kid })}.${b64({
        iss: clientId, sub: clientId, aud: 'https://id.example.com/token', exp: now + 120, jti: crypto.randomUUID(), ...claims
    })}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(sig).toString('base64url')}`;
}

export async function dpopKey() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwk = { kty, crv, x, y };
    const proof = async ({ htm = 'POST', htu = 'https://id.example.com/token', iat = Math.floor(Date.now() / 1000), jti = crypto.randomUUID(), accessToken, header = {} } = {}) => {
        const ath = accessToken ? Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))).toString('base64url') : undefined;
        const input = `${b64({ typ: 'dpop+jwt', alg: 'ES256', jwk, ...header })}.${b64({ htm, htu, iat, jti, ...(ath ? { ath } : {}) })}`;
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
        return `${input}.${Buffer.from(sig).toString('base64url')}`;
    };
    return { jwk, proof, jkt: await thumbprint(jwk) };
}
