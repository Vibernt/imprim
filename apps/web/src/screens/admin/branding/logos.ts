import { html, nothing } from 'lit';
import { icon } from '../../../lib/icon';
import { assets, type Asset, type Branding } from './types';

const labels = {
  logo_light: ['Full logo', 'Shown at the top of sign-in pages in place of the mark and name.'],
  logo_dark: ['Dark-mode logo', 'Optional. Shown when the page is dark.'],
  mark: ['Mark', 'A square icon for browser tabs and pages without a full logo.'],
};

export const assetUrl = (id: string) => '/assets/brand/' + id;

export function logoFields(brand: Branding, realmName: string, pending: boolean,
  change: (event: CustomEvent<{ value: File[] }>, slot: Asset) => void) {
  const name = brand.name || realmName;
  return html`<div class="fd-stack" data-gap="5">${assets.map(slot => {
    const [label, description] = labels[slot];
    const labelId = slot + '-label', current = brand[slot];
    return html`<div class="fd-field">
      <span class="fd-field-label" id=${labelId}>${label}</span>
      <p class="fd-field-hint">${description}</p>
      <div class="fd-dropzone" data-fd-dropzone data-layout="logo" data-max-mb="0.25" role="group" aria-labelledby=${labelId}
        aria-disabled=${String(pending)} @fd:files=${(event: Event) => event.preventDefault()}
        @fd:change=${(event: CustomEvent<{ value: File[] }>) => change(event, slot)}>
        <input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" tabindex="-1" aria-label=${label} ?disabled=${pending}>
        <span class="fd-dropzone-preview">
          ${current ? html`<img src=${assetUrl(current)} alt=${'Current ' + label.toLowerCase()}>` : nothing}
          <span class="fd-tile" data-size="44" data-fd-initial=${name}></span>
        </span>
        <span class="fd-dropzone-text">
          <span class="fd-dropzone-hint">SVG, PNG, JPEG or WebP, up to 256 KiB.</span>
          <span class="fd-file-bar" role="progressbar" aria-label=${'Uploading ' + label.toLowerCase()} aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></span>
          <span class="fd-file-status"></span>
        </span>
        <span class="fd-dropzone-actions">
          <button type="button" class="fd-btn" data-size="sm" data-fd-file-pick ?disabled=${pending}>${icon('upload')}<span>Upload</span></button>
          <button type="button" class="fd-btn" data-variant="ghost" data-size="sm" data-fd-file-clear ?disabled=${pending}>Remove</button>
        </span>
      </div>
      <p class="fd-field-error" id=${slot + '-error'} hidden></p>
    </div>`;
  })}</div>`;
}

// Fire releases its object URLs on replacement or Remove. Discard and route changes unmount the fields.
export function releaseLogoPreviews(root: HTMLElement) {
  for (const image of root.querySelectorAll<HTMLImageElement>('.fd-dropzone-preview > img[src^="blob:"]')) {
    URL.revokeObjectURL(image.src);
  }
}

export function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1]));
    reader.addEventListener('error', () => reject(new Error('The logo file could not be read.')));
    reader.readAsDataURL(file);
  });
}
