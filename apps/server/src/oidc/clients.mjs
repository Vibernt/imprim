import { signInSettings } from './sign-in-methods.mjs';
import { invariant } from '../lib/errors.mjs';
import { sha256, safeEqual } from '../lib/crypto.mjs';
import { realmId } from '../realms/realm.mjs';
export async function getClient(env, id) {
    invariant(typeof id === 'string' && id.length > 0 && id.length <= 200, 'invalid_client', 'Unknown client.');
    // A client exists only in its own realm: another realm's host treats it as unknown.
    const client = await env.DB.prepare('SELECT * FROM clients WHERE id=? AND realm_id=?').bind(id, realmId(env)).first();
    invariant(client, 'invalid_client', 'Unknown client.');
    signInSettings(client);
    return client;
}
export function registeredUri(client, uri, field = 'redirect_uris') {
    invariant(typeof uri === 'string' && uri.length <= 2048, 'invalid_request', 'Invalid redirect URI.');
    let url;
    try { url = new URL(uri); } catch { invariant(false, 'invalid_request', 'Invalid redirect URI.'); }
    invariant(!url.hash && !url.username && !url.password && !/[\s\\]/.test(uri), 'invalid_request', 'Invalid redirect URI.');
    invariant(url.protocol === 'https:' || (client.dev === 1 && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
        'invalid_request', 'HTTPS redirect URI required.');
    invariant(JSON.parse(client[field]).includes(uri), 'invalid_request', 'Redirect URI is not registered.');
    return uri;
}
export async function authenticateClient(request, env, body = {}, confidentialOnly = false) {
    const header = request.headers.get('authorization');
    if (!header) {
        invariant(!body.client_secret && !confidentialOnly, 'invalid_client', 'Client authentication required.', 401);
        const client = await getClient(env, body.client_id);
        invariant(!client.secret_hash, 'invalid_client', 'Client authentication required.', 401);
        return client;
    }
    invariant(/^Basic [A-Za-z0-9+/]+=*$/i.test(header), 'invalid_client', 'client_secret_basic required.', 401);
    let id, secret;
    try {
        const decoded = atob(header.slice(6)), index = decoded.indexOf(':');
        invariant(index > 0, 'invalid_client', 'Malformed credentials.', 401);
        const decode = value => decodeURIComponent(value.replaceAll('+', ' '));
        id = decode(decoded.slice(0, index)); secret = decode(decoded.slice(index + 1));
    } catch { invariant(false, 'invalid_client', 'Malformed credentials.', 401); }
    invariant(!body.client_secret && (!body.client_id || body.client_id === id), 'invalid_client', 'Conflicting client credentials.', 401);
    const client = await env.DB.prepare('SELECT * FROM clients WHERE id=? AND realm_id=?').bind(id, realmId(env)).first();
    const hash = await sha256(secret);
    const matches = await safeEqual(hash, client?.secret_hash || '0'.repeat(64));
    invariant(client?.secret_hash && matches, 'invalid_client', 'Invalid client credentials.', 401);
    signInSettings(client);
    return client;
}
