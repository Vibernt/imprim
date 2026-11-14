import test from 'node:test';
import assert from 'node:assert/strict';
import { world, login, basic } from './support/world.mjs';

test('authorization code round trip signs ES256 and authenticates userinfo', async t => {
    const w = await world(t), signed = await login(w, t);
    assert.equal(signed.response.status, 303);
    const location = new URL(signed.response.headers.get('location'));
    assert.equal(location.searchParams.get('iss'), w.env.ISSUER);
    assert.equal(location.searchParams.get('state'), 'rp-state');
    const response = await w.exchange(signed.code);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    const [head, body, sig] = tokens.id_token.split('.');
    const header = JSON.parse(Buffer.from(head, 'base64url'));
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    assert.equal(header.alg, 'ES256');
    assert.equal(claims.nonce, 'rp-nonce');
    assert.equal(claims.aud, 'app');
    assert.equal(claims.azp, 'app');
    assert.equal(claims.iss, w.env.ISSUER);
    assert.equal(claims.exp - claims.iat, 600);
    assert.deepEqual(claims.amr, ['email']);
    assert.equal(claims.email_verified, true);
    assert.ok(claims.sid && claims.auth_time);
    const jwks = await (await w.call('/.well-known/jwks.json')).json();
    assert.ok(jwks.keys.every(key => key.alg === 'ES256' && !key.d));
    const key = await crypto.subtle.importKey('jwk', jwks.keys.find(k => k.kid === header.kid), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64url'), Buffer.from(`${head}.${body}`)), true);
    const info = await w.call('/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(info.status, 200);
    assert.equal((await info.json()).sub, claims.sub);
});
for (const [name, changes] of Object.entries({
    'unknown client': { client_id: 'missing' }, 'unregistered redirect': { redirect_uri: 'https://evil.example/' },
    'http redirect': { redirect_uri: 'http://app.example/callback' }, 'javascript redirect': { redirect_uri: 'javascript:alert(1)' },
    'missing PKCE': { code_challenge: null }, 'plain PKCE': { code_challenge_method: 'plain' },
    'missing state': { state: null }, 'missing nonce': { nonce: null }, 'wrong response type': { response_type: 'token' }
})) test(`authorize refuses ${name}`, async t => {
    const w = await world(t), response = await w.authorize(changes);
    // A validated redirect may receive an OAuth error, never a code.
    assert.ok(response.status === 400 || response.status === 303);
    assert.ok(!response.headers.get('location')?.includes('code='));
    assert.equal(w.env.DB.db.prepare('SELECT count(*) AS n FROM codes').get().n, 0);
});
test('prompt none without a session returns login_required and issuer', async t => {
    const w = await world(t), response = await w.authorize({ prompt: 'none' });
    const url = new URL(response.headers.get('location'));
    assert.equal(url.searchParams.get('error'), 'login_required');
    assert.equal(url.searchParams.get('iss'), w.env.ISSUER);
});
for (const kind of ['replay', 'wrong client', 'wrong verifier', 'expired', 'wrong secret', 'wrong redirect'])
    test(`token refuses ${kind}`, async t => {
        const w = await world(t), signed = await login(w, t);
        if (kind === 'replay') assert.equal((await w.exchange(signed.code)).status, 200);
        if (kind === 'expired') w.env.DB.db.exec('UPDATE codes SET expires_at=0');
        const response = await w.exchange(signed.code,
            kind === 'wrong verifier' ? { code_verifier: 'x'.repeat(43) } : kind === 'wrong redirect' ? { redirect_uri: 'https://evil.example/' } : {},
            kind === 'wrong client' ? basic('other') : kind === 'wrong secret' ? basic('app', 'wrong') : basic());
        assert.equal(response.status, kind === 'wrong secret' ? 401 : 400);
        if (kind === 'replay') assert.equal(w.env.DB.db.prepare("SELECT count(*) AS n FROM audit WHERE event='code_replay'").get().n, 1);
    });
