import { invariant } from '../lib/errors.mjs';
// Bound untrusted provider responses; never follow redirects or expose their payloads in errors.
export async function googleJson(url, init = {}) {
    let response;
    try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { invariant(false, 'google_unavailable', 'Google request failed.', 502); }
    invariant(response.ok && response.body, 'google_unavailable', 'Google request failed.', 502);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) { await reader.cancel(); invariant(false, 'google_unavailable', 'Google response too large.', 502); }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { data: JSON.parse(text), headers: response.headers };
    } catch { invariant(false, 'google_unavailable', 'Invalid Google response.', 502); }
    finally { reader.releaseLock(); }
}
