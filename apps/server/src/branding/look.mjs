// A brand's look is the Fire design system's tweak state: palette, tone, type set, density, corners, lines, text
// size, contrast, motion, texture and theme. The server applies it the way Fire's Tweaks panel does (fire/js/tweaks.js):
// attributes on <html>, and the toned palette and scales as custom properties, here in /assets/theme.css. Fire's palette
// engine re-applies its contrast rules after any tone change, so every look keeps text and accent legible.
import { PALETTES, DEFAULT_PALETTE, TONE_DEFAULT, TONE_RANGE, cssValue } from 'fire-design/fire/js/palettes.js';
import { TYPEFACES, DEFAULT_TYPEFACE } from 'fire-design/fire/js/typefaces.js';
import { DIAL_CHOICES, DIAL_DEFAULTS, expandTheme, SIGNATURE_CHOICES, SIGNATURE_DEFAULT, SIGNATURE_RANGES } from 'fire-design/fire/js/theme.js';
import { fireRecord } from './record.mjs';
import { invariant } from '../lib/errors.mjs';
const LOOK_DEFAULTS = Object.freeze({ palette: DEFAULT_PALETTE, type: DEFAULT_TYPEFACE, theme: 'system', ...DIAL_DEFAULTS });
const CHOICES = { theme: ['light', 'dark', 'system'], ...DIAL_CHOICES };
const RANGES = { corners: [0, 2, 0.125], texture: [0, 1.5, 0.05] };
export const PALETTE_NAMES = PALETTES.map(p => p.name), TYPE_NAMES = TYPEFACES.map(t => t.name);
const fail = message => invariant(false, 'branding', message, 400);
const onStep = (value, [min, max, step]) => typeof value === 'number' && value >= min && value <= max && Math.abs(value / step - Math.round(value / step)) < 1e-9;
function validateSignature(signature, label) {
    if (!signature || typeof signature !== 'object' || Array.isArray(signature)) fail(`${label} must be an object.`);
    for (const [key, value] of Object.entries(signature)) {
        if (!Object.hasOwn(SIGNATURE_DEFAULT, key)) fail(`Unknown ${label} key ${key}.`);
        if (key === 'cell' && (value === 'auto' || onStep(value, [...SIGNATURE_RANGES.cell, 1]))) continue;
        if (key === 'intensity' && onStep(value, [...SIGNATURE_RANGES.intensity, 0.05])) continue;
        if (Object.hasOwn(SIGNATURE_CHOICES, key) && SIGNATURE_CHOICES[key].includes(value)) continue;
        fail(`Invalid ${label}.${key} setting.`);
    }
}
// Strict: a value outside Fire's own choices is refused, not clamped, so what is saved is what is shown.
export function validateLook(look, label = 'look') {
    if (look === undefined) return;
    if (!look || typeof look !== 'object' || Array.isArray(look)) fail(`${label} must be an object.`);
    for (const [key, value] of Object.entries(look)) {
        if (key === 'palette') { if (!PALETTE_NAMES.includes(value)) fail(`${label}.palette is one of ${PALETTE_NAMES.join(', ')}.`); }
        else if (key === 'type') { if (!TYPE_NAMES.includes(value)) fail(`${label}.type is one of ${TYPE_NAMES.join(', ')}.`); }
        else if (key === 'tone') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}.tone must be an object.`);
            for (const [k, v] of Object.entries(value)) {
                if (!Object.hasOwn(TONE_RANGE, k)) fail(`Unknown ${label}.tone key ${k}.`);
                if (!Number.isInteger(v) || v < TONE_RANGE[k][0] || v > TONE_RANGE[k][1]) fail(`${label}.tone.${k} is a whole number from ${TONE_RANGE[k][0]} to ${TONE_RANGE[k][1]}.`);
            }
        }
        else if (key === 'signature') validateSignature(value, `${label}.signature`);
        else if (Object.hasOwn(CHOICES, key)) { if (!CHOICES[key].includes(value)) fail(`${label}.${key} is one of ${CHOICES[key].join(', ')}.`); }
        else if (Object.hasOwn(RANGES, key)) { if (!onStep(value, RANGES[key])) fail(`${label}.${key} is ${RANGES[key][0]} to ${RANGES[key][1]} in steps of ${RANGES[key][2]}.`); }
        else fail(`Unknown ${label} setting ${key}.`);
    }
    return look;
}
// Realm look, then the app's; tone and signature merge per key.
export const resolveLook = (realm = {}, app = {}) => ({ ...LOOK_DEFAULTS, ...realm, ...app,
    tone: { ...TONE_DEFAULT, ...realm.tone, ...app.tone }, signature: { ...SIGNATURE_DEFAULT, ...realm.signature, ...app.signature } });
// Imprim stores Fire's dials flat and keeps a realm default for the light/dark choice.
const expandLook = look => expandTheme(fireRecord(look));

export function lookAttributeEntries(look) {
    const { attributes } = expandLook(look);
    const { 'data-palette': palette, 'data-type': type, ...dials } = attributes;
    return [['data-palette', palette], ['data-type', type], ['data-theme', look.theme !== 'system' ? look.theme : undefined],
        ...Object.entries(dials)].filter(([, value]) => value !== undefined);
}
export const lookAttributes = look => lookAttributeEntries(look).map(([name, value]) => ` ${name}="${value}"`).join('');
export function lookCss(look) {
    const props = Object.entries(expandLook(look).tokens).map(([name, value]) => `${name}:${Array.isArray(value) ? cssValue(value) : value}`);
    return props.length ? `:root:root{${props.join(';')}}\n` : '';
}
