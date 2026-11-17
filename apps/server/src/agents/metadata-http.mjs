import { invariant } from '../lib/errors.mjs';
import { cleanUrl } from './uris.mjs';
// Conservative public-address classification: deny special-purpose ranges as well as private networks.
export function publicAddress(address) {
    const value = address.replace(/^\[|\]$/g, '').toLowerCase();
    if (value.includes(':')) {
        // IPv4-mapped, NAT64, ULA, link-local, loopback and multicast are outside global unicast.
        return /^[23][0-9a-f]{3}:/.test(value) && !/^2001:(?:0*:|0*2:|db8:|[12][0-9a-f]:)/.test(value) && !value.startsWith('2002:');
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
    const [a,b,c,d] = value.split('.').map(Number);
    return [a,b,c,d].every(n => n >= 0 && n <= 255) && a > 0 && a < 224 && a !== 10 && a !== 127 &&
        !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
        !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) && !(a === 198 && (b === 18 || b === 19 || b === 51)) && !(a === 203 && b === 0 && c === 113);
}
export async function boundedJson(response, limit = 65536) {
    if (!response.ok || response.redirected || (response.headers.has('content-length') && Number(response.headers.get('content-length')) > limit)) {
        if (response.body) await response.body.cancel();
        invariant(false, 'invalid_client_metadata', 'Metadata fetch failed, redirected, or exceeded the size limit.');
    }
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    invariant(reader, 'invalid_client_metadata', 'Empty metadata response.');
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); invariant(false, 'invalid_client_metadata', 'Metadata is too large.'); }
        chunks.push(value);
    }
    try { return JSON.parse(await new Blob(chunks).text()); }
    catch { invariant(false, 'invalid_client_metadata', 'Invalid metadata JSON.'); }
}
export function metadataUrl(id) {
    const url = cleanUrl(id, 'invalid_client_metadata');
    // Port 443 only: any other port turns the fetcher into a timing oracle for port probes (S10).
    invariant(url.protocol === 'https:' && url.href === id && !url.port && !url.hostname.endsWith('.') &&
        !/(^|\.)(localhost|local|internal|home|lan)$/.test(url.hostname), 'invalid_client_metadata', 'Client ID must be a public HTTPS URL.');
    const literal = url.hostname.includes(':') || /^[\d.]+$/.test(url.hostname);
    invariant(!literal || publicAddress(url.hostname), 'invalid_client_metadata', 'Private or reserved client address.');
    return { url, literal };
}
export const fetchMetadata = id => fetchJson(id, ['application/json']);
export async function fetchJson(id, types) {
    const { url, literal } = metadataUrl(id);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    const options = { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' } };
    try {
        if (!literal) {
            // Fixed resolver, both address families; any forbidden answer fails the request.
            const answers = await Promise.all(['A','AAAA'].map(async type => {
                const dns = new URL('https://cloudflare-dns.com/dns-query');
                dns.search = new URLSearchParams({ name: url.hostname, type }).toString();
                const data = await boundedJson(await fetch(dns.href, { ...options, headers: { accept: 'application/dns-json' } }));
                invariant(data.Status === 0, 'invalid_client_metadata', 'Client DNS resolution failed.');
                return (data.Answer || []).filter(record => [1,28].includes(record.type)).map(record => record.data);
            }));
            invariant(answers.flat().length > 0 && answers.flat().every(publicAddress), 'invalid_client_metadata', 'Client DNS contains private or reserved addresses.');
        }
        // Production uses Workers global fetch, with its public-network egress boundary; no service/VPC binding.
        const response = await fetch(id, options);
        const type = response.headers.get('content-type')?.split(';')[0].trim();
        if (!types.includes(type)) {
            if (response.body) await response.body.cancel();
            invariant(false, 'invalid_client_metadata', 'Metadata must be served as {types}.', 400, { types: types.join(' or ') });
        }
        const document = await boundedJson(response);
        return { document, headers: response.headers };
    } catch (error) {
        if (error.code) throw error;
        invariant(false, 'invalid_client_metadata', 'Client metadata DNS or HTTPS request failed (5 second deadline).');
    } finally { clearTimeout(timer); }
}
// Documents are cached for at least five minutes, whatever their headers say, so an uncacheable document is not
// refetched on every refresh (S10). The ceiling stays one hour.
export const CACHE_FLOOR_MS = 300000;
export const cacheLifetime = (headers, now = Date.now()) => Math.max(CACHE_FLOOR_MS, headerLifetime(headers, now));
export function headerLifetime(headers, now = Date.now()) {
    const cc = headers.get('cache-control') || '';
    if (/(?:^|,)\s*(?:no-store|no-cache|private)\b/i.test(cc) || headers.get('vary') === '*') return 0;
    const age = Number(headers.get('age') || 0);
    if (!Number.isFinite(age) || age < 0) return 0;
    const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(cc);
    const date = Date.parse(headers.get('date') || ''), expires = Date.parse(headers.get('expires') || '');
    const lifetime = match ? Number(match[1]) * 1000 : Number.isFinite(expires) ? expires - (Number.isFinite(date) ? date : now) : 0;
    const elapsed = Math.max(age * 1000, Number.isFinite(date) ? now - date : 0);
    return Math.max(0, Math.min(3600000, lifetime - elapsed));
}
