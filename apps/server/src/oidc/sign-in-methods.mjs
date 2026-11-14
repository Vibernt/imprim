import { invariant } from '../lib/errors.mjs';
// Ordered per client.
export const METHODS = ['email', 'password', 'passkey', 'github', 'google'];
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function validateSignInSettings(methods, domains = []) {
    invariant(Array.isArray(methods) && methods.length > 0 && methods.length <= METHODS.length &&
        methods.every(method => METHODS.includes(method)) && new Set(methods).size === methods.length,
    'client_config', `sign_in_methods must be a nonempty ordered list of distinct methods from ${METHODS.join(', ')}.`, 503);
    invariant(Array.isArray(domains) && domains.every(domain => typeof domain === 'string' && domain.length <= 253 && domainPattern.test(domain)) &&
        new Set(domains).size === domains.length, 'client_config', 'google_hosted_domains must contain distinct lowercase domains.', 503);
    return { methods, domains };
}
export function signInSettings(client) {
    let methods, domains;
    try { methods = JSON.parse(client.sign_in_methods); domains = JSON.parse(client.google_hosted_domains); }
    catch { invariant(false, 'client_config', 'Invalid client sign-in configuration.', 503); }
    return validateSignInSettings(methods, domains);
}
export function allowsMethod(client, method, hd = null, checkDomain = false) {
    const { methods, domains } = signInSettings(client);
    return methods.includes(method) && (!checkDomain || method !== 'google' || !domains.length || domains.includes(hd));
}
export function requireMethod(client, method, hd = null, checkDomain = false) {
    invariant(allowsMethod(client, method, hd, checkDomain), 'access_denied', 'Sign-in method or hosted domain is not allowed for this app.', 403);
}
