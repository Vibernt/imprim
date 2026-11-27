import { html, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../../lib/icon';
import { card } from '../../page-layout';
import { assetUrl } from './logos';
import type { Branding } from './types';

const sections = [
  ['look', 'Look', 'palette'], ['logos', 'Logos', 'image'], ['name', 'Name and links', 'link'],
  ['languages', 'Languages', 'globe'], ['words', 'Words', 'type'],
] as const;
export type Section = typeof sections[number][0];

export function brandingTabs(selected: Section, panels: Record<Section, TemplateResult>,
  select: (section: Section) => void, pending: boolean) {
  return html`
    <div class="fd-tabs" role="tablist" aria-label="Branding"
      @fd:change=${(event: CustomEvent<{ value: Section }>) => select(event.detail.value)}>
      ${sections.map(([id, label, glyph]) => html`
        <button class="fd-tab" type="button" role="tab" aria-selected=${String(selected === id)}
          id=${'branding-tab-' + id} aria-controls=${'branding-panel-' + id} data-value=${id}>${icon(glyph)}${label}</button>`)}
    </div>
    ${sections.map(([id, label]) => html`
      <div class="fd-tab-panel" id=${'branding-panel-' + id} role="tabpanel" aria-labelledby=${'branding-tab-' + id}
        ?hidden=${selected !== id}>
        <fieldset class="fd-stack" data-gap="4" ?disabled=${pending}>
          <legend class="fd-sr-only">${label}</legend>
          ${card(label, panels[id])}
        </fieldset>
      </div>`)}
  `;
}

export function specimen(brand: Branding, realmName: string) {
  const name = brand.name || realmName;
  const design = JSON.stringify({ name, mark: brand.mark && assetUrl(brand.mark),
    logo: brand.logo_light && assetUrl(brand.logo_light), logoDark: brand.logo_dark && assetUrl(brand.logo_dark) });
  return card('Sign-in preview', html`
    <div class="fd-screen" inert aria-label="Sample sign-in">
      ${keyed(design, html`<div data-fd-brand=${design}>
        <div class="fd-brand"><span class="fd-brand-name">${name}</span></div>
      </div>`)}
      <div class="fd-corners"><article class="fd-card" data-size="lg" data-variant="sunken">
        <header class="fd-screen-head">
          <p class="fd-h1">${brand.copy?.sign_in_heading || 'Sign in to ' + name}</p>
          ${brand.copy?.sign_in_help ? html`<p class="fd-muted">${brand.copy.sign_in_help}</p>` : ''}
        </header>
        <div class="fd-stack" data-gap="4">
          <div class="fd-field"><label class="fd-field-label" for="branding-preview-email">Email</label>
            <input class="fd-input" id="branding-preview-email" data-size="lg" type="email" placeholder="you@example.com"></div>
          <button class="fd-btn" data-variant="primary" data-size="lg" data-block type="button">
            ${icon('mail')}<span>Email me a link</span>
          </button>
        </div>
      </article></div>
    </div>
    <div class="fd-row" data-wrap data-gap="3">
      <a class="fd-link" href="/admin/branding/preview" target="_blank" rel="noopener">${icon('external-link')} Open saved sign-in page</a>
      <a class="fd-link" href="/admin/branding/email-preview" target="_blank" rel="noopener">${icon('mail')} Open sample email</a>
    </div>
  `);
}
