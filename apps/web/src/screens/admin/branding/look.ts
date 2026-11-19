import type { TweaksChangeDetail } from 'fire-design';
import { fromThemeRecord } from 'fire-design/theme';
import { fireRecord, savedLook } from '../../../../../server/src/branding/record.mjs';
import type { Look } from './types';

const patch = (look: Look) => ({ ...fromThemeRecord(fireRecord(look)), theme: look.theme ?? 'system' as const });

const themeAttribute = /^data-(?:theme$|accent$|palette$|type$|density$|text-size$|contrast$|surfaces$|elevation$|controls$|headings$|imagery$|signature-)/;

function captureLook(root: HTMLElement) {
  const names = root.getAttributeNames().filter(name => themeAttribute.test(name));
  const attributes = new Map(names.map(name => [name, root.getAttribute(name)!]));
  const props = new Map([...root.style].map(name => [name, [root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]]));
  const stylesheet = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href^="/assets/theme.css"]');
  const disabled = stylesheet?.disabled ?? false;
  const preferenceKeys = ['fd-theme', 'fd-density'];
  const preferences = new Map(preferenceKeys.map(name => [name, localStorage.getItem(name)]));
  return {
    start() { if (stylesheet) stylesheet.disabled = true; },
    restore() {
      if (stylesheet) stylesheet.disabled = disabled;
      for (const [name, value] of preferences) {
        if (value === null) localStorage.removeItem(name);
        else localStorage.setItem(name, value);
      }
      for (const name of root.getAttributeNames()) if (themeAttribute.test(name) && !attributes.has(name)) root.removeAttribute(name);
      for (const [name, value] of attributes) root.setAttribute(name, value);
      for (const name of [...root.style]) if (!props.has(name)) root.style.removeProperty(name);
      for (const [name, [value, priority]] of props) root.style.setProperty(name, value, priority);
      if (!root.style.length) root.removeAttribute('style');
    },
  };
}

export async function openLookPreview(look: Look, onChange: (look: Look) => void, signal: AbortSignal) {
  const root = document.documentElement;
  const page = captureLook(root);
  let restore = () => page.restore();
  // Register before loading Tweaks so leaving a document restores preferences before Fire flushes them.
  const leave = () => restore();
  addEventListener('pagehide', leave, { once: true });
  let tweaks: typeof import('fire-design/fire/js/tweaks.js');
  try {
    tweaks = await import('fire-design/fire/js/tweaks.js');
  } catch (error) {
    removeEventListener('pagehide', leave);
    page.restore();
    throw error;
  }
  if (signal.aborted) {
    removeEventListener('pagehide', leave);
    page.restore();
    return;
  }
  const previous = tweaks.get();
  let live = true;
  const changed = (event: Event) => {
    const detail = (event as CustomEvent<TweaksChangeDetail>).detail;
    if (detail?.name === 'tweaks') onChange(savedLook(detail.value));
  };
  restore = () => {
    if (!live) return;
    live = false;
    removeEventListener('pagehide', leave);
    root.removeEventListener('fd:change', changed);
    tweaks.close();
    tweaks.set(previous);
    page.restore();
  };
  signal.addEventListener('abort', leave, { once: true });
  page.start();
  root.addEventListener('fd:change', changed);
  tweaks.set(patch(look));
  return tweaks;
}
