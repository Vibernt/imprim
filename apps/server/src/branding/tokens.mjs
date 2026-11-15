// Branding is tokens only: a Fire look (palette, tone, type set and the other tweaks; see look.mjs), links, copy and
// logo asset ids. There is no custom CSS or JS, so a brand can never weaken CSP or put script on a page that handles
// credentials. Contrast is Fire's job: its palette engine keeps text and accent legible for every palette and tone.
import { invariant } from '../lib/errors.mjs';
import { validateLook, resolveLook } from './look.mjs';
export const COPY_KEYS = ['sign_in_heading', 'sign_in_help', 'consent_intro', 'signed_out', 'footer'];
const LINKS = ['support_url', 'privacy_url', 'terms_url'], ASSETS = ['logo_light', 'logo_dark', 'mark'];
const fail = message => invariant(false, 'branding', message, 400);
// No control characters (C0, C1, line and paragraph separators) or bidirectional overrides, which could spoof text.
const plain = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(value);
// Shape check for a realm default or an app override.
export function validateBranding(value, { app = false } = {}) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('branding must be an object.');
    const known = ['name', 'legal_name', 'support_email', 'locale', 'look', 'copy', ...LINKS, ...ASSETS];
    for (const key of Object.keys(value)) if (!known.includes(key)) fail(`Unknown branding field ${key}.`);
    if (value.name !== undefined && value.name !== '' && !plain(value.name, 200)) fail('branding.name is up to 200 characters of plain text.');
    if (value.legal_name !== undefined && !plain(value.legal_name, 200)) fail('branding.legal_name is 1 to 200 characters.');
    for (const key of LINKS) if (value[key] !== undefined && !(typeof value[key] === 'string' && /^https:\/\/[^\s<>"']{1,500}$/.test(value[key]))) fail(`branding.${key} must be an https URL.`);
    if (value.support_email !== undefined && !(typeof value.support_email === 'string' && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value.support_email) && value.support_email.length <= 254)) fail('branding.support_email must be an email address.');
    if (value.locale !== undefined && !(typeof value.locale === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(value.locale))) fail('branding.locale is a language tag such as en or en-GB.');
    for (const key of ASSETS) if (value[key] !== undefined && !(typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key]))) fail(`branding.${key} must be an uploaded asset id.`);
    validateLook(value.look);
    if (value.copy !== undefined) {
        if (!value.copy || typeof value.copy !== 'object' || Array.isArray(value.copy)) fail('branding.copy must be an object.');
        for (const [key, text] of Object.entries(value.copy)) { if (!COPY_KEYS.includes(key)) fail(`Unknown copy key ${key}.`); if (!plain(text, 300)) fail(`copy.${key} is 1 to 300 characters of plain text.`); }
    }
    return value;
}
// Realm defaults, then the app's overrides; the look and copy merge per key.
export function resolveBranding(realmBranding = {}, appOverride = {}) {
    // An empty app value (the console's default `name: ''`) means "use the realm's", not "blank it".
    const appBranding = Object.fromEntries(Object.entries(appOverride).filter(([, value]) => value !== '' && value !== undefined && value !== null));
    const merged = { ...realmBranding, ...appBranding,
        look: resolveLook(realmBranding.look, appBranding.look),
        copy: { ...realmBranding.copy, ...appBranding.copy } };
    return merged;
}
export const brandingFor = (env, client) => resolveBranding(env.REALM?.branding || {}, client ? JSON.parse(client.branding || '{}') : {});
