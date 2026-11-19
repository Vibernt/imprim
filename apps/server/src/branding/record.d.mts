import type { ThemeRecord, TweaksPatch, TweaksState } from 'fire-design/fire/fire.js';

type Look = Omit<TweaksPatch, 'brand'>;
export function fireRecord(look: Look): ThemeRecord;
export function savedLook(state: TweaksState): Look;
