import { invariant } from '../lib/errors.mjs';
import { registeredUri } from '../oidc/clients.mjs';

export function checkClientId(id) {
    invariant(typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id), 'invalid_request', 'Invalid client id.');
}

export function checkClientUris(uris, name, dev) {
    invariant(Array.isArray(uris) && uris.length <= 100 && (name !== 'redirect_uris' || uris.length), 'invalid_request', 'Invalid URI list.');
    const client = { dev, [name]: JSON.stringify(uris) };
    for (const uri of uris) registeredUri(client, uri, name);
}
