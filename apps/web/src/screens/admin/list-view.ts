import { html, nothing, type TemplateResult } from 'lit';

type Cell = string | number | TemplateResult;
type EmptyMessage = readonly [title: string, description: string];

export function table(name: string, headings: string[], rows: Cell[][], empty?: EmptyMessage,
  details?: (TemplateResult | typeof nothing)[]) {
  return html`<div class="fd-table-wrap">
    <div class="fd-table-scroll" tabindex="0" role="region" aria-label=${name}>
      <table class="fd-table" aria-label=${name}>
        <thead><tr>${headings.map(heading => html`<th scope="col" ?data-actions=${heading === 'Actions'}>${heading}</th>`)}</tr></thead>
        <tbody>
          ${rows.length || !empty ? rows.map((row, rowIndex) => html`
            <tr>${row.map((value, index) => html`<td ?data-actions=${headings[index] === 'Actions'}>${value}</td>`)}</tr>
            ${details?.[rowIndex] && details[rowIndex] !== nothing ? html`
              <tr class="fd-table-detail"><td colspan=${headings.length}>${details[rowIndex]}</td></tr>` : nothing}`)
          : html`<tr class="fd-table-state"><td colspan=${headings.length}>
            <div class="fd-table-empty">
              <h2 class="fd-table-empty-title">${empty[0]}</h2>
              <p class="fd-table-empty-text">${empty[1]}</p>
            </div>
          </td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

export function listCount(count: number, singular: string, plural: string) {
  return html`<div class="fd-toolbar"><p class="fd-muted">${count} ${count === 1 ? singular : plural}</p></div>`;
}
