// A brand's look is the Fire design system's tweak state: palette, tone, type set, density, corners, lines, text
// size, contrast, motion, texture and theme. The server applies it the way Fire's Tweaks panel does (fire/js/tweaks.js):
// attributes on <html>, and the toned palette and scales as custom properties, here in /assets/theme.css. Fire's palette
// engine re-applies its contrast rules after any tone change, so every look keeps text and accent legible.
import { PALETTES, DEFAULT_PALETTE, PALETTE_TOKENS, TONE_DEFAULT, TONE_RANGE, paletteTokens, toneTokens, cssValue, isDefaultTone } from '../../public/fire/js/palettes.js';
import { TYPEFACES, DEFAULT_TYPEFACE } from '../../public/fire/js/typefaces.js';
import { invariant } from '../lib/errors.mjs';
const LOOK_DEFAULTS = Object.freeze({ palette: DEFAULT_PALETTE, type: DEFAULT_TYPEFACE, tone: TONE_DEFAULT, theme: 'system', density: 'comfortable',
    corners: 1, lines: 1, textSize: 'md', contrast: 'default', motion: 'default', texture: 1 });
const CHOICES = { theme: ['light', 'dark', 'system'], density: ['compact', 'comfortable', 'spacious'], textSize: ['sm', 'md', 'lg'], contrast: ['default', 'high'],
    motion: ['off', 'default', 'slow'], lines: [1, 1.5, 2] };
const RANGES = { corners: [0, 2, 0.125], texture: [0, 1.5, 0.05] };
const MOTION = { off: 0, default: 1, slow: 1.75 };
export const PALETTE_NAMES = PALETTES.map(p => p.name), TYPE_NAMES = TYPEFACES.map(t => t.name);
const fail = message => invariant(false, 'branding', message, 400);
const onStep = (value, [min, max, step]) => typeof value === 'number' && value >= min && value <= max && Math.abs(value / step - Math.round(value / step)) < 1e-9;
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
        else if (Object.hasOwn(CHOICES, key)) { if (!CHOICES[key].includes(value)) fail(`${label}.${key} is one of ${CHOICES[key].join(', ')}.`); }
        else if (Object.hasOwn(RANGES, key)) { if (!onStep(value, RANGES[key])) fail(`${label}.${key} is ${RANGES[key][0]} to ${RANGES[key][1]} in steps of ${RANGES[key][2]}.`); }
        else fail(`Unknown ${label} setting ${key}.`);
    }
    return look;
}
// Realm look, then the app's; tone merges per key.
export const resolveLook = (realm = {}, app = {}) => ({ ...LOOK_DEFAULTS, ...realm, ...app, tone: { ...TONE_DEFAULT, ...realm.tone, ...app.tone } });
// Attributes for <html>. A toned palette is written out in full as custom properties instead of data-palette.
export function lookAttributes(look) {
    const toned = !isDefaultTone(look.tone), attrs = [];
    if (look.palette !== DEFAULT_PALETTE && !toned) attrs.push(['data-palette', look.palette]);
    if (look.type !== DEFAULT_TYPEFACE) attrs.push(['data-type', look.type]);
    if (look.theme !== 'system') attrs.push(['data-theme', look.theme]);
    if (look.density !== 'comfortable') attrs.push(['data-density', look.density]);
    if (look.textSize !== 'md') attrs.push(['data-text-size', look.textSize]);
    if (look.contrast === 'high') attrs.push(['data-contrast', 'high']);
    // Every value comes from Fire's fixed lists, so it needs no escaping; the names are checked again here.
    return attrs.filter(([, value]) => /^[a-z0-9-]+$/.test(value)).map(([name, value]) => ` ${name}="${value}"`).join('');
}
// Custom properties for :root, exactly as the Tweaks panel writes them inline.
export function lookCss(look) {
    const props = [];
    if (!isDefaultTone(look.tone)) {
        const toned = toneTokens(paletteTokens(look.palette, { contrast: look.contrast }), look.tone);
        for (const name of PALETTE_TOKENS) props.push([name, cssValue(toned[name])]);
    }
    if (look.corners !== 1) props.push(['--fd-radius-scale', String(look.corners)]);
    if (look.lines !== 1) props.push(['--fd-hairline', `${look.lines}px`]);
    if (look.motion !== 'default') props.push(['--fd-motion', String(MOTION[look.motion])]);
    if (look.texture !== 1) props.push(['--fd-texture', String(look.texture)]);
    return props.length ? `:root:root{${props.map(([k, v]) => `${k}:${v}`).join(';')}}\n` : '';
}
