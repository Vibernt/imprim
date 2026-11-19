import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../../lib/icon';
import { assets, type Asset, type Branding } from './types';

const labels = {
  logo_light: ['Full logo', 'Shown at the top of sign-in pages in place of the mark and name.'],
  logo_dark: ['Dark-mode logo', 'Optional. Shown when the page is dark.'],
  mark: ['Mark', 'A square icon for browser tabs and pages without a full logo.'],
};

export const assetUrl = (id: string) => '/assets/brand/' + id;

export function logoFields(brand: Branding, pending: boolean,
  change: (event: CustomEvent<{ value: File[] }>, slot: Asset) => void, remove: (slot: Asset) => void) {
  return html`<div class="fd-stack" data-gap="5">${assets.map(slot => {
    const [label, description] = labels[slot], current = brand[slot];
    return keyed(current ?? slot, html`<div class="fd-field">
      <span class="fd-field-label" id=${slot + '-label'}>${label}</span>
      <p class="fd-field-hint">${description}</p>
      ${current ? html`<div class="fd-row" data-gap="3">
        <span class="fd-brand" data-fd-brand-keep><img class="fd-brand-logo" src=${assetUrl(current)} alt=${'Current ' + label.toLowerCase()}></span>
        <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" aria-label=${'Remove ' + label.toLowerCase()}
          ?disabled=${pending} @click=${() => remove(slot)}>Remove</button>
      </div>` : nothing}
      <label class="fd-dropzone" data-fd-dropzone data-layout="inline" data-max-mb="0.25"
        aria-disabled=${pending} @fd:files=${(event: Event) => event.preventDefault()}
        @fd:change=${(event: CustomEvent<{ value: File[] }>) => change(event, slot)}>
        <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" aria-labelledby=${slot + '-label'} ?disabled=${pending}>
        <span class="fd-dropzone-icon">${icon('cloud-upload')}</span>
        <span class="fd-dropzone-text">
          <span class="fd-dropzone-title">Upload ${label.toLowerCase()}</span>
          <span class="fd-dropzone-hint">SVG, PNG, JPEG or WebP, up to 256 KiB.</span>
        </span>
      </label>
      <ul class="fd-filelist"></ul>
    </div>`);
  })}</div>`;
}

export function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1]));
    reader.addEventListener('error', () => reject(new Error('The logo file could not be read.')));
    reader.readAsDataURL(file);
  });
}
