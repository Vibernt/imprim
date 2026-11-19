import { html, nothing, type TemplateResult } from 'lit';
import { icon } from '../../lib/icon';

type Field = {
  id: string; label: string; name: string; value?: string | null; hint?: string; required?: boolean;
  mono?: boolean; type?: string; placeholder?: string; pattern?: string; maxlength?: number; minlength?: number;
};
type Label = Pick<Field, 'id' | 'label' | 'hint' | 'required'>;
const describedBy = (field: Label) => field.hint ? field.id + '-hint' : nothing;
const hint = (field: Label) => field.hint
  ? html`<p class="fd-field-hint" id=${field.id + '-hint'}>${field.hint}</p>` : nothing;

function labelled(field: Label, control: TemplateResult) {
  return html`<div class="fd-field">
    <label class="fd-field-label" for=${field.id} ?data-required=${field.required}>${field.label}</label>
    ${control}${hint(field)}
  </div>`;
}

export const text = (field: Field) => labelled(field, html`
  <input class="fd-input" id=${field.id} name=${field.name} type=${field.type ?? 'text'} .value=${field.value ?? ''}
    ?data-mono=${field.mono} ?required=${field.required} placeholder=${field.placeholder ?? nothing}
    pattern=${field.pattern ?? nothing} maxlength=${field.maxlength ?? nothing} minlength=${field.minlength ?? nothing}
    autocomplete="off" spellcheck="false" aria-describedby=${describedBy(field)}>`);

export const shown = (label: string, value: string) => html`
  <div class="fd-field"><span class="fd-field-label">${label}</span><span class="fd-input" data-mono>${value}</span></div>`;

type Control = Pick<Field, 'id' | 'label' | 'name' | 'hint' | 'required'>;
const changedControls = new WeakMap<EventTarget, unknown>();
function rememberControl(event: CustomEvent<{ value: unknown }>) {
  if (event.currentTarget) changedControls.set(event.currentTarget, event.detail.value);
}

// Fire owns the enhanced fields. A change replaces their initial value without rerendering their containers.
export function fireValue<T>(form: HTMLFormElement, name: string, initial: T): T {
  const root = form.querySelector(`[data-im-control="${name}"]`);
  if (!root) throw new Error(`Missing Fire control ${name}.`);
  return changedControls.has(root) ? changedControls.get(root) as T : initial;
}

export const list = (field: Control & { values: string[]; rows?: number; pattern?: string; placeholder?: string }) =>
  labelled(field, html`
    <div class="fd-tag-input" data-fd-tag-input data-format="json" data-mono data-im-control=${field.name}
      data-pattern=${field.pattern ?? nothing} @fd:change=${rememberControl}>
      <textarea id=${field.id} name=${field.name} rows=${field.rows ?? 2} ?required=${field.required}
        placeholder=${field.placeholder ?? nothing} spellcheck="false" aria-describedby=${describedBy(field)} .value=${JSON.stringify(field.values)}></textarea>
    </div>`);

export const pairs = (field: Control & { values: Record<string, string>; keyLabel: string; valueLabel: string;
  keyPlaceholder: string; valuePlaceholder: string; addLabel: string }) => labelled(field, html`
  <div class="fd-pairs" data-fd-pairs data-format="json" data-mono="key" data-im-control=${field.name}
    data-key-label=${field.keyLabel} data-value-label=${field.valueLabel} data-key-placeholder=${field.keyPlaceholder}
    data-value-placeholder=${field.valuePlaceholder} data-add-label=${field.addLabel} @fd:change=${rememberControl}>
    <textarea id=${field.id} name=${field.name} rows="3" spellcheck="false" aria-describedby=${describedBy(field)} .value=${JSON.stringify(field.values)}></textarea>
  </div>`);

export const jsonField = (field: Control & { value: unknown }) => labelled(field, html`
  <div class="fd-codefield" data-fd-json>
    <div class="fd-codefield-head"><span class="fd-codefield-lang">JSON</span>
      <button class="fd-btn" type="button" data-variant="ghost" data-size="xs" data-fd-codefield-format>Format</button>
    </div>
    <textarea class="fd-codefield-input" id=${field.id} name=${field.name} rows="8" spellcheck="false" autocapitalize="off"
      ?required=${field.required} aria-describedby=${describedBy(field)} .value=${JSON.stringify(field.value, null, 2)}></textarea>
  </div>`);

type Options = Control & { options: [string, string][] };
export const choice = (field: Options & { value: string }) => html`
  <div class="fd-field" role="radiogroup" aria-labelledby=${field.id + '-label'} aria-describedby=${describedBy(field)}>
    <span class="fd-field-label" id=${field.id + '-label'}>${field.label}</span>
    <div><div class="fd-segmented">${field.options.map(([value, label]) => html`
      <label class="fd-segmented-item"><input type="radio" name=${field.name} value=${value} ?checked=${value === field.value}>
        <span>${label}</span></label>`)}</div></div>
    ${hint(field)}
  </div>`;

export const checkbox = (name: string, label: string, checked = false, value = '1', required = false) => html`
  <label class="fd-checkbox"><input type="checkbox" name=${name} value=${value} ?checked=${checked} ?required=${required}>
    <span class="fd-checkbox-box"></span><span class="fd-checkbox-text"><span class="fd-checkbox-label">${label}</span></span>
  </label>`;

export const checks = (field: Options & { chosen: string[] }) => html`
  <div class="fd-field" role="group" aria-labelledby=${field.id + '-label'} aria-describedby=${describedBy(field)}>
    <span class="fd-field-label" id=${field.id + '-label'}>${field.label}</span>
    <div class="fd-grid" data-min="sm" data-gap="2" data-gap-x="4">
      ${field.options.map(([value, label]) => checkbox(field.name, label, field.chosen.includes(value), value))}
    </div>${hint(field)}
  </div>`;

export const toggle = (field: Control & { desc: string; on: string; checked: boolean }) => html`
  <div class="fd-form-row"><div class="fd-form-row-text">
    <span class="fd-form-row-label" id=${field.id + '-label'}>${field.label}</span>
    <span class="fd-form-row-desc" id=${field.id + '-desc'}>${field.desc}</span>
  </div><div class="fd-form-row-control"><label class="fd-switch">
    <input type="checkbox" role="switch" id=${field.id} name=${field.name} value=${field.on} ?checked=${field.checked}
      aria-labelledby=${field.id + '-label'} aria-describedby=${field.id + '-desc'}><span class="fd-switch-track"></span>
  </label></div></div>`;

export const amount = (field: Control & { value: number; unit: string; min: number; max?: number }) =>
  labelled(field, html`<div class="fd-input-group" data-fit>
    <input class="fd-input" type="number" id=${field.id} name=${field.name} .value=${String(field.value)}
      min=${field.min} max=${field.max ?? nothing} step="1" required aria-describedby=${describedBy(field)}>
    <span class="fd-input-affix" data-kind="unit">${field.unit}</span>
  </div>`);

export const cols = (...fields: TemplateResult[]) => html`<div class="fd-form-cols">${fields}</div>`;

export const formSection = (id: string, title: string, description: string, ...fields: TemplateResult[]) => html`
  <section class="fd-form-section" aria-labelledby=${id + '-title'}>
    <header class="fd-form-section-head">
      <h2 class="fd-form-section-title" id=${id + '-title'}>${title}</h2>
      <p class="fd-form-section-desc">${description}</p>
    </header>
    <div class="fd-form-section-body">${fields}</div>
  </section>`;

export const advanced = (title: string, content: TemplateResult) => html`
  <details class="fd-disclosure"><summary class="fd-disclosure-trigger"><span>${title}</span>${icon('chevron-down')}</summary>
    <div class="fd-disclosure-panel"><div class="fd-disclosure-inner">${content}</div></div>
  </details>`;
