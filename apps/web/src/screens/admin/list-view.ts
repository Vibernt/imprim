import { html, nothing, type TemplateResult } from 'lit';

type Cell = string | number | TemplateResult;
type EmptyMessage = readonly [title: string, description: string, action?: TemplateResult];
type TableOptions = { title?: string; stackHide?: string[]; numeric?: string[]; emptyOnly?: boolean };

export function table(name: string, headings: string[], rows: Cell[][], empty?: EmptyMessage,
  options: TableOptions = {}) {
  const title = options.title ?? headings[0];
  const stack = (heading: string) => options.stackHide?.includes(heading) ? 'hide' : nothing;
  return html`<div class="fd-table-wrap">
    <div class="fd-table-scroll" tabindex="0" role="region" aria-label=${name}>
      <table class="fd-table" data-stack data-wrap aria-label=${name}>
        ${rows.length || !options.emptyOnly ? html`<thead><tr>${headings.map(heading => html`
          <th scope="col" data-label=${heading === 'Actions' ? '' : nothing} data-stack=${stack(heading)} ?data-num=${options.numeric?.includes(heading)}>${heading}</th>`)}</tr></thead>` : nothing}
        <tbody>
          ${rows.length || !empty ? rows.map(row => html`
            <tr>${row.map((value, index) => {
              const heading = headings[index];
              return html`<td ?data-stack-title=${heading === title} data-stack=${stack(heading)}
                ?data-num=${options.numeric?.includes(heading)} data-label=${heading === title || heading === 'Actions' ? nothing : heading}>${value}</td>`;
            })}</tr>`)
          : html`<tr class="fd-table-state"><td colspan=${headings.length}>
            <div class="fd-table-empty">
              <h2 class="fd-table-empty-title">${empty[0]}</h2>
              <p class="fd-table-empty-text">${empty[1]}</p>
              ${empty[2] ?? nothing}
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
