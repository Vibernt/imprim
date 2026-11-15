// Fire's form controls for values that are not plain text: a list, names with values, a choice, a switch, a number
// with a unit, raw JSON. Each is chosen by the kind of value (docs/fire/GUIDE.md section 5, "Forms"), posts in a plain
// form and works without script; /imprim/forms.js (FORMS_MODULE) upgrades them. Every text argument is escaped here.
import { escapeHtml as e, attrs, button, icon } from './ui.mjs';
export const FORMS_MODULE = '/imprim/forms.js';
const hint = (id, text) => text ? `<p class="fd-field-hint" id="${e(id)}-hint">${e(text)}</p>` : '';
const describedBy = (id, text) => text ? `${id}-hint` : undefined;
// A field with a <label>. `control` is already-safe markup whose main element has this id.
const labelled = ({ id, label, required, hint: text }, control) =>
    `<div class="fd-field"><label class="fd-field-label" for="${e(id)}"${required ? ' data-required' : ''}>${e(label)}</label>${control}${hint(id, text)}</div>`;
// A field whose control is a group of inputs: the label names the group.
const grouped = ({ id, label, hint: text }, role, control) =>
    `<div class="fd-field" role="${role}" aria-labelledby="${e(id)}-label"${text ? ` aria-describedby="${e(id)}-hint"` : ''}><span class="fd-field-label" id="${e(id)}-label">${e(label)}</span>${control}${hint(id, text)}</div>`;
// One line of text. mono: identifiers and URLs.
export const text = ({ id, label, name, value = '', required, mono, type, placeholder, pattern, maxlength, hint: tip }) => labelled({ id, label, required, hint: tip },
    `<input class="fd-input"${attrs({ id, name, type, value, 'data-mono': mono, required, placeholder, pattern, maxlength, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': describedBy(id, tip) })}>`);
// A value shown in a field's shape, not editable.
export const shown = ({ label, value, mono }) => `<div class="fd-field"><span class="fd-field-label">${e(label)}</span><span class="fd-input"${mono ? ' data-mono' : ''}>${e(value)}</span></div>`;
// A list of free values (URLs, domains): tokens with script, one value per line without. Posts the lines.
export const list = ({ id, label, name, values = [], required, placeholder, pattern, rows = 2, hint: tip }) => labelled({ id, label, required, hint: tip },
    `<div class="fd-tag-input" data-fd-tag-input data-mono${pattern ? ` data-pattern="${e(pattern)}"` : ''}><textarea${attrs({ name, id, rows, required, placeholder, spellcheck: 'false', 'aria-describedby': describedBy(id, tip) })}>${e(values.join('\n'))}</textarea></div>`);
// Names with values: rows of two inputs with script, "name = value" lines without. With script it posts a JSON object,
// so a name may hold "=". entries: [[name, value]].
export const pairs = ({ id, label, name, entries = [], keyLabel, valueLabel, keyPlaceholder, valuePlaceholder, addLabel, rows = 3, hint: tip }) => labelled({ id, label, hint: tip },
    `<div class="fd-pairs" data-fd-pairs data-format="json" data-mono="key"${attrs({ 'data-key-label': keyLabel, 'data-value-label': valueLabel, 'data-key-placeholder': keyPlaceholder, 'data-value-placeholder': valuePlaceholder, 'data-add-label': addLabel })}><textarea${
        attrs({ name, id, rows, spellcheck: 'false', 'aria-describedby': describedBy(id, tip) })}>${e(entries.map(([key, value]) => `${key} = ${value}`).join('\n'))}</textarea></div>`);
// Raw JSON, for the few settings where that is the right input. Checked on blur and on submit, with a Format button.
export const json = ({ id, label, name, value, rows = 8, hint: tip }) => labelled({ id, label, hint: tip },
    `<div class="fd-codefield" data-fd-json><div class="fd-codefield-head"><span class="fd-codefield-lang">JSON</span>${
        button('Format', { type: 'button', variant: 'ghost', size: 'xs', 'data-fd-codefield-format': true })}</div><textarea class="fd-codefield-input"${
        attrs({ name, id, rows, spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': describedBy(id, tip) })}>${e(JSON.stringify(value, null, 2))}</textarea></div>`);
// One of two to four options: native radios in Fire's segmented control. options: [[value, label]].
export const choice = ({ id, label, name, value, options, hint: tip }) => grouped({ id, label, hint: tip }, 'radiogroup',
    `<div><div class="fd-segmented">${options.map(([option, text]) => `<label class="fd-segmented-item"><input type="radio"${attrs({ name, value: option, checked: option === value })}><span>${e(text)}</span></label>`).join('')}</div></div>`);
// Several of a fixed set. Each box has its own name, `name.value`, because a form may not repeat a name here
// (lib/http.mjs); admin/client-form.mjs gathers them in the order they appear. options: [[value, label]].
export const checks = ({ id, label, name, options, chosen = [], hint: tip }) => grouped({ id, label, hint: tip }, 'group',
    `<div class="fd-grid" data-min="sm" data-gap="2" data-gap-x="4">${options.map(([option, text]) => `<label class="fd-checkbox"><input type="checkbox"${attrs({ name: `${name}.${option}`, value: '1', checked: chosen.includes(option) })}><span class="fd-checkbox-box"></span><span class="fd-checkbox-text"><span class="fd-checkbox-label">${e(text)}</span></span></label>`).join('')}</div>`);
// Yes or no, saved with the form. `on` is the value posted when it is on; off posts nothing.
export const toggle = ({ id, label, desc, name, on = '1', checked }) => `<div class="fd-form-row"><div class="fd-form-row-text"><span class="fd-form-row-label" id="${e(id)}-label">${e(label)}</span>${
    desc ? `<span class="fd-form-row-desc" id="${e(id)}-desc">${e(desc)}</span>` : ''}</div><div class="fd-form-row-control"><label class="fd-switch"><input type="checkbox" role="switch"${
    attrs({ id, name, value: on, checked, 'aria-labelledby': `${id}-label`, 'aria-describedby': desc ? `${id}-desc` : undefined })}><span class="fd-switch-track"></span></label></div></div>`;
// A whole number with its unit beside it.
export const amount = ({ id, label, name, value, unit, min, max, hint: tip }) => labelled({ id, label, hint: tip },
    `<div class="fd-input-group" data-fit><input class="fd-input" type="number" size="4"${attrs({ id, name, value, min, max, step: 1, required: true, 'aria-describedby': describedBy(id, tip) })}><span class="fd-input-affix" data-kind="unit">${e(unit)}</span></div>`);
// Two fields side by side where there is room.
export const cols = (...fields) => `<div class="fd-form-cols">${fields.join('')}</div>`;
// One section of a long form: its title and one line on the left, its fields on a surface on the right.
export const formSection = (id, title, description, body) => `<section class="fd-form-section" aria-labelledby="${e(id)}-title"><header class="fd-form-section-head"><h2 class="fd-form-section-title" id="${e(id)}-title">${e(title)}</h2>${
    description ? `<p class="fd-form-section-desc">${e(description)}</p>` : ''}</header><div class="fd-form-section-body">${body}</div></section>`;
// Something most people leave alone, folded away.
export const advanced = (label, body) => `<details class="fd-disclosure"><summary class="fd-disclosure-trigger"><span>${e(label)}</span>${icon('chevron-down')}</summary><div class="fd-disclosure-panel"><div class="fd-disclosure-inner">${body}</div></div></details>`;
