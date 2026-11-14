// Have I Been Pwned range API (k-anonymity): only the first five hex characters of the SHA-1 leave the Worker, and
// padding hides the response size. If the check cannot run, the password is refused: no unchecked password is stored.
import { invariant } from '../lib/errors.mjs';
const unavailable = () => invariant(false, 'breach_check_unavailable', 'We cannot check new passwords right now. Try again in a few minutes, or sign in with an email link.', 503);
export async function assertNotBreached(password) {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password.normalize('NFKC'))))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    let response;
    try { response = await fetch(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'add-padding': 'true', 'user-agent': 'imprim' } }); }
    catch { unavailable(); }
    if (!response.ok) { if (response.body) await response.body.cancel(); unavailable(); }
    let text;
    try { text = await response.text(); } catch { unavailable(); }
    if (text.length > 2000000) unavailable();
    const suffix = digest.slice(5);
    for (const line of text.split('\n')) {
        const [hash, count] = line.trim().split(':');
        invariant(!(hash === suffix && Number(count) > 0), 'breached_password', 'This password has appeared in a data breach. Choose a different one.');
    }
}
