// A coarse, human-readable description of the request's device and place, from the user agent and Cloudflare's
// request metadata. Used for the sessions list and new-device notices; never for any security decision.
// Stored in English ("Chrome on macOS"); shown in the reader's language by deviceText. `say(id, vars)` translates.
export function deviceText(stored, say) {
    const generic = { 'Browser': say('Browser'), 'Command line': say('Command line') };
    const match = /^(.+) on (iOS|Android|macOS|Windows|Linux)$/.exec(stored || '');
    return match ? say('{browser} on {system}', { browser: generic[match[1]] ?? match[1], system: match[2] }) : generic[stored] ?? stored;
}
export function describeDevice(request) {
    const ua = request.headers.get('user-agent') || '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'Command line' : 'Browser';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    const cf = request.cf || {};
    const place = [cf.city, cf.country || request.headers.get('cf-ipcountry')].filter(value => typeof value === 'string' && value && value !== 'XX').join(', ');
    return { device: os ? `${browser} on ${os}` : browser, location: place.slice(0, 80) || null };
}
