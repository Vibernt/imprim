import { html, nothing, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';

type OptionalMarkup = TemplateResult | typeof nothing;

export function pageHead(title: string, description = '', back: OptionalMarkup = nothing, actions: OptionalMarkup = nothing) {
  return html`<section class="fd-band" data-pad="sm">
    <div class="fd-page-head">
      <div class="fd-page-head-text">
        ${back === nothing ? nothing : html`<div class="fd-row">${back}</div>`}
        <h1 class="fd-page-head-title">${title}</h1>
        ${description ? html`<p class="fd-page-head-desc">${description}</p>` : nothing}
      </div>
      ${actions === nothing ? nothing : html`<div class="fd-page-head-actions">${actions}</div>`}
    </div>
  </section>`;
}

export function card(title: string, content: TemplateResult, description?: string) {
  return html`<section class="fd-card">
    <div class="fd-card-head"><div class="fd-card-heading">
      <h2 class="fd-title">${title}</h2>
      ${description ? html`<p class="fd-card-desc">${description}</p>` : nothing}
    </div></div>
    ${content}
  </section>`;
}

export function setting(title: string | TemplateResult, description: string | TemplateResult, control: TemplateResult, danger = false) {
  return html`<div class="fd-setting" data-tone=${danger ? 'danger' : nothing}>
    <div class="fd-setting-text">
      <div class="fd-setting-title">${title}</div>
      ${description ? html`<div class="fd-setting-desc">${description}</div>` : nothing}
    </div>
    <div class="fd-setting-control">${control}</div>
  </div>`;
}

// Fire's code block script rewrites the text inside it (highlighting), so Lit must not update that text in place:
// keyed on the text, a changed value gets a fresh block (Fire owns what it writes: spec/EXPORT.md O1, O2).
export const codeBlock = (label: string, value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  return html`${keyed(text, html`
  <div class="fd-codeblock" data-wrap>
    <pre class="fd-codeblock-body" tabindex="0" role="region" aria-label=${label}><code>${text}</code></pre>
  </div>`)}`;
};

export function formSection(id: string, title: string, content: TemplateResult, description?: string) {
  return html`<section class="fd-form-section" aria-labelledby=${id}>
    <header class="fd-form-section-head">
      <h2 class="fd-form-section-title" id=${id}>${title}</h2>
      ${description ? html`<p class="fd-form-section-desc">${description}</p>` : nothing}
    </header>
    <div class="fd-form-section-body">${content}</div>
  </section>`;
}
