import { html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { skeleton, type SkeletonOptions, type SkeletonPreset } from 'fire-design/skeleton';

export interface LoadingPreset { name: SkeletonPreset; options: SkeletonOptions }

export const recordSkeleton: readonly LoadingPreset[] = [
  { name: 'stat', options: { count: 3 } },
  { name: 'text', options: { lines: 6 } },
];

export function loading(preset: readonly LoadingPreset[], label: { status: string; late: string }) {
  return html`<div role="status" data-fd-loading="true">
    ${keyed(label.late, html`<p class="fd-skeleton-late">${label.late}</p>`)}
    <span class="fd-sr-only">${label.status}</span>
    ${preset.map(({ name, options }) => unsafeHTML(skeleton(name, options)))}
  </div>`;
}
