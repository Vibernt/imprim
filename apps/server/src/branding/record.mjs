import { DEFAULT_PALETTE, TONE_DEFAULT } from 'fire-design/fire/js/palettes.js';
import { DIAL_DEFAULTS, SIGNATURE_DEFAULT } from 'fire-design/fire/js/theme.js';
import { DEFAULT_TYPEFACE } from 'fire-design/fire/js/typefaces.js';

const defaults = { ...DIAL_DEFAULTS, palette: DEFAULT_PALETTE, type: DEFAULT_TYPEFACE, theme: 'system' };
const differences = (state, baseline) => Object.fromEntries(Object.entries(state).filter(([key, value]) => value !== baseline[key]));

// A saved look is relative to Fire's defaults. Tweaks' Reset instead returns to the look declared on the page.
export function savedLook({ tone, signature, ...dials }) {
  const look = differences(dials, defaults);
  const changedTone = differences(tone, TONE_DEFAULT);
  const changedSignature = differences(signature, SIGNATURE_DEFAULT);
  if (Object.keys(changedTone).length) look.tone = changedTone;
  if (Object.keys(changedSignature).length) look.signature = changedSignature;
  return look;
}

export const fireRecord = ({ palette, type, tone, signature, theme, ...dials }) => ({ palette, type, tone, signature, dials });
