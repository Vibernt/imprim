import { html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../../lib/icon';
import { assetUrl } from './logos';
import type { Branding } from './types';

export const sections = [
  ['look', 'Look', 'palette'], ['logos', 'Logos', 'image'], ['name', 'Name and links', 'link'],
  ['languages', 'Languages', 'globe'], ['words', 'Words', 'type'],
] as const;
export type Section = typeof sections[number][0];

export function specimen(brand: Branding, realmName: string) {
  const name = brand.name || realmName;
  const design = JSON.stringify({ name, mark: brand.mark && assetUrl(brand.mark),
    logo: brand.logo_light && assetUrl(brand.logo_light), logoDark: brand.logo_dark && assetUrl(brand.logo_dark) });
  return html`
  <section class="fd-stack" data-gap="3" aria-labelledby="branding-preview">
    <h2 class="fd-h2" id="branding-preview">Sign-in preview</h2>
    <div class="fd-screen" role="group" aria-label="Sample sign-in">
      ${keyed(design, html`<div data-fd-brand=${design}>
        <div class="fd-brand"><span class="fd-brand-name">${name}</span></div>
      </div>`)}
      <article class="fd-card" data-size="lg">
        <header class="fd-screen-head">
          <p class="fd-h1">${brand.copy?.sign_in_heading || 'Sign in to ' + name}</p>
          <p class="fd-muted">${brand.copy?.sign_in_help || 'Use the email your team invited.'}</p>
        </header>
        <div class="fd-field"><span class="fd-field-label">Email</span><span class="fd-input" data-size="lg">dana@example.com</span></div>
        <button class="fd-btn" data-variant="primary" data-size="lg" data-block type="button" disabled>Email me a link</button>
        <button class="fd-btn" data-variant="outline" data-size="lg" data-block type="button" disabled>Sign in with a passkey</button>
      </article>
    </div>
    <div class="fd-row" data-wrap data-gap="3">
      <a class="fd-link" href="/admin/branding/preview" target="_blank" rel="noopener">${icon('external-link')} Open saved sign-in page</a>
      <a class="fd-link" href="/admin/branding/email-preview" target="_blank" rel="noopener">${icon('mail')} Open sample email</a>
    </div>
  </section>`;
}
