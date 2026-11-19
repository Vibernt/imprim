import { catalogues } from '../i18n/index.mjs';
import { sha256 } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';

const prepared = new Map();
export async function catalogueResponse(request, locale) {
    // A URL identifies the bytes independently of the visitor, allowing shared caches.
    const catalogue = catalogues.get(locale);
    invariant(catalogue, 'not_found', 'Endpoint not found.', 404);
    if (!prepared.has(catalogue)) {
        const body = JSON.stringify(catalogue);
        prepared.set(catalogue, sha256(body).then(hash => ({ body, etag: `"${hash}"` })));
    }
    const { body, etag } = await prepared.get(catalogue);
    const headers = { etag, 'cache-control': 'public, max-age=3600' };
    const tags = request.headers.get('if-none-match')?.split(',').map(tag => tag.trim().replace(/^W\//, ''));
    if (tags?.includes(etag) || tags?.includes('*')) return new Response(null, { status: 304, headers });
    return new Response(body, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
}
