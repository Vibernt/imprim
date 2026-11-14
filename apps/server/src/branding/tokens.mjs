// Branding is tokens only: colours, radius, a font from a fixed list of system stacks, links, copy and logo asset ids.
// There is no custom CSS or JS, so a brand can never weaken CSP or put script on a page that handles credentials.
import { invariant } from '../lib/errors.mjs';
export const FONTS = {
    system: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif',
    humanist: 'Seravek,"Gill Sans Nova",Ubuntu,Calibri,"DejaVu Sans",source-sans-pro,sans-serif',
    geometric: 'Avenir,Montserrat,Corbel,"URW Gothic",source-sans-pro,sans-serif',
    serif: 'Charter,"Bitstream Charter","Sitka Text",Cambria,Georgia,serif',
    mono: 'ui-monospace,"Cascadia Code","Source Code Pro",Menlo,Consolas,monospace'
};
const COLOURS = ['primary', 'primary_text', 'background', 'surface', 'text', 'muted', 'border'];
export const DEFAULT_THEME = { primary: '#2346d8', primary_text: '#ffffff', background: '#f4f5f7', surface: '#ffffff', text: '#14181d', muted: '#525c67', border: '#d5dae0', radius: 10, font: 'system' };
export const DEFAULT_DARK = { primary: '#8aa8ff', primary_text: '#0a0f1f', background: '#0e1115', surface: '#161a20', text: '#e7ebf0', muted: '#a2acb7', border: '#2b323b' };
export const COPY_KEYS = ['sign_in_heading', 'sign_in_help', 'consent_intro', 'signed_out', 'footer'];
const LINKS = ['support_url', 'privacy_url', 'terms_url'], ASSETS = ['logo_light', 'logo_dark', 'mark'];
// WCAG 2.x relative luminance and contrast ratio.
const channel = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Text pairs that must meet WCAG AA for normal text (4.5:1).
const PAIRS = [['text', 'background'], ['text', 'surface'], ['muted', 'surface'], ['primary_text', 'primary'], ['primary', 'surface']];
export function checkContrast(theme, label) {
    for (const [fg, bg] of PAIRS) {
        const ratio = contrast(theme[fg], theme[bg]);
        invariant(ratio >= 4.5, 'branding_contrast', `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1; WCAG AA needs 4.5:1.`, 400);
    }
}
const fail = message => invariant(false, 'branding', message, 400);
const plain = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(value);
function theme(value, label, dark = false) {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    for (const [key, v] of Object.entries(value)) {
        if (COLOURS.includes(key)) { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) fail(`${label}.${key} must be a #rrggbb colour.`); }
        else if (key === 'radius' && !dark) { if (!Number.isInteger(v) || v < 0 || v > 24) fail(`${label}.radius is 0 to 24 (pixels).`); }
        else if (key === 'font' && !dark) { if (!Object.hasOwn(FONTS, v)) fail(`${label}.font is one of ${Object.keys(FONTS).join(', ')}.`); }
        else fail(`Unknown ${label} token ${key}.`);
    }
}
// Shape check for a realm default or an app override. Contrast is checked on the merged result (resolveBranding).
export function validateBranding(value, { app = false } = {}) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('branding must be an object.');
    const known = ['name', 'legal_name', 'support_email', 'locale', 'theme', 'theme_dark', 'copy', ...LINKS, ...ASSETS];
    for (const key of Object.keys(value)) if (!known.includes(key)) fail(`Unknown branding field ${key}.`);
    if (value.name !== undefined && !(typeof value.name === 'string' && value.name.length <= 200 && !/[\u0000-\u001f]/.test(value.name))) fail('branding.name is at most 200 characters.');
    if (value.legal_name !== undefined && !plain(value.legal_name, 200)) fail('branding.legal_name is 1 to 200 characters.');
    for (const key of LINKS) if (value[key] !== undefined && !(typeof value[key] === 'string' && /^https:\/\/[^\s<>"']{1,500}$/.test(value[key]))) fail(`branding.${key} must be an https URL.`);
    if (value.support_email !== undefined && !(typeof value.support_email === 'string' && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value.support_email) && value.support_email.length <= 254)) fail('branding.support_email must be an email address.');
    if (value.locale !== undefined && !/^[a-z]{2}(-[A-Z]{2})?$/.test(value.locale)) fail('branding.locale is a language tag such as en or en-GB.');
    for (const key of ASSETS) if (value[key] !== undefined && !(typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key]))) fail(`branding.${key} must be an uploaded asset id.`);
    theme(value.theme, 'theme'); theme(value.theme_dark, 'theme_dark', true);
    if (value.copy !== undefined) {
        if (!value.copy || typeof value.copy !== 'object' || Array.isArray(value.copy)) fail('branding.copy must be an object.');
        for (const [key, text] of Object.entries(value.copy)) { if (!COPY_KEYS.includes(key)) fail(`Unknown copy key ${key}.`); if (!plain(text, 300)) fail(`copy.${key} is 1 to 300 characters of plain text.`); }
    }
    return value;
}
// Realm defaults, then the app's overrides; theme and copy merge per key.
export function resolveBranding(realmBranding = {}, appBranding = {}) {
    const merged = { ...realmBranding, ...appBranding,
        theme: { ...DEFAULT_THEME, ...realmBranding.theme, ...appBranding.theme },
        theme_dark: { ...DEFAULT_DARK, ...realmBranding.theme_dark, ...appBranding.theme_dark },
        copy: { ...realmBranding.copy, ...appBranding.copy } };
    return merged;
}
export function assertContrast(branding) {
    checkContrast(branding.theme, 'Light theme');
    checkContrast({ ...branding.theme, ...branding.theme_dark }, 'Dark theme');
}
export const brandingFor = (env, client) => resolveBranding(env.REALM?.branding || {}, client ? JSON.parse(client.branding || '{}') : {});
