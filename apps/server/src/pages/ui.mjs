// Fire components rendered on the server, so pages that handle credentials need no client-side framework. Markup follows
// the Fire docs (docs/fire/VOCABULARY.md); copy follows docs/fire/WRITING.md. Every argument that is text is escaped here.
import { ICONS } from 'fire-design/fire/js/icons.js';
import { t } from '../i18n/index.mjs';
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const e = escapeHtml;
export const attrs = (pairs = {}) => Object.entries(pairs).filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => v === true ? ` ${k}` : ` ${k}="${e(v)}"`).join('');
// Lucide icons from Fire's set, inline (Fire's own <i data-icon> needs its JavaScript).
export function icon(name, size) {
    if (!Object.hasOwn(ICONS, name)) throw new Error(`Unknown Fire icon: ${name}`);
    return `<svg class="fd-icon" viewBox="0 0 24 24"${size ? ` data-size="${size}"` : ''} aria-hidden="true">${ICONS[name]}</svg>`;
}
export { dotLogo, dotMark } from './dots.mjs';
// The head of a centred screen: its heading and one line, centred.
export const heading = (title, description = '') => `<header class="fd-screen-head"><h1 class="fd-h1">${e(title)}</h1>${description ? `<p class="fd-muted">${e(description)}</p>` : ''}</header>`;
// The top of a result screen (link sent, signed out, stopped): an icon tile, then the heading, centred.
export const result = (name, tone, title, description = '') => `<header class="fd-screen-head"><span class="fd-tile" data-size="44" data-tone="${tone}">${icon(name)}</span><h1 class="fd-h1">${e(title)}</h1>${description ? `<p class="fd-muted">${e(description)}</p>` : ''}</header>`;
export const section = (title, description, body) => `<section class="fd-stack" data-gap="3"><div class="fd-stack" data-gap="1"><h2 class="fd-h3">${e(title)}</h2>${description ? `<p class="fd-small fd-muted">${e(description)}</p>` : ''}</div>${body}</section>`;
// A button. `html` is already-safe inner markup (an icon plus escaped text); otherwise `label` is escaped.
export function button(label, { variant, size, block, type = 'submit', icon: name, html, ...rest } = {}) {
    return `<button class="fd-btn"${attrs({ type, 'data-variant': variant, 'data-size': size, 'data-block': block, ...rest })}>${name ? icon(name) : ''}<span>${html ?? e(label)}</span></button>`;
}
export const linkButton = (label, href, { variant, size, block, icon: name } = {}) =>
    `<a class="fd-btn"${attrs({ href, 'data-variant': variant, 'data-size': size, 'data-block': block })}>${name ? icon(name) : ''}<span>${e(label)}</span></a>`;
export function field({ id, label, hint, error, size, ...input }) {
    const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
    const control = input.multiline
        ? `<textarea class="fd-textarea"${attrs({ id, 'data-mono': input.mono, rows: input.rows ?? 6, name: input.name, required: input.required, spellcheck: input.mono ? 'false' : undefined, 'aria-describedby': describedBy })}>${e(input.value ?? '')}</textarea>`
        : `<input class="fd-input"${attrs({ id, 'data-size': size, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': describedBy, type: input.type, name: input.name, value: input.value,
            placeholder: input.placeholder, autocomplete: input.autocomplete, autocapitalize: input.autocapitalize, inputmode: input.inputmode, maxlength: input.maxlength, minlength: input.minlength, pattern: input.pattern,
            required: input.required, autofocus: input.autofocus, readonly: input.readonly, spellcheck: input.spellcheck })}>`;
    return `<div class="fd-field"><label class="fd-field-label" for="${e(id)}">${e(label)}</label>${control}${hint ? `<p class="fd-field-hint" id="${e(id)}-hint">${e(hint)}</p>` : ''}${error ? `<p class="fd-field-error" id="${e(id)}-error">${icon('circle-alert', 14)}<span>${e(error)}</span></p>` : ''}</div>`;
}
// A 6-digit code in Fire's one-time-code boxes. It is one ordinary input, so the form works without script;
// /imprim/forms.js (FORMS_MODULE in forms.mjs; load it with the page) turns it into the boxes, and the form posts the same `name` either way.
export function otp({ id, label, name, hint, error, autofocus, length = 6 }) {
    const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
    return `<div class="fd-field"><label class="fd-field-label" for="${e(id)}">${e(label)}</label><div class="fd-otp" data-fd-otp data-length="${length}" role="group" aria-label="${e(label)}"><input${attrs({ id, name,
        inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: length, pattern: `[0-9]{${length}}`, required: true, autofocus, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': describedBy })}></div>${
        hint ? `<p class="fd-field-hint" id="${e(id)}-hint">${e(hint)}</p>` : ''}${error ? `<p class="fd-field-error" id="${e(id)}-error">${icon('circle-alert', 14)}<span>${e(error)}</span></p>` : ''}</div>`;
}
export const checkbox = (name, label, { value = '1', checked, required } = {}) =>
    `<label class="fd-checkbox"><input type="checkbox"${attrs({ name, value, checked, required })}><span class="fd-checkbox-box"></span><span class="fd-checkbox-text"><span class="fd-checkbox-label">${e(label)}</span></span></label>`;
export const radio = (name, label, { value, checked, required, description } = {}) =>
    `<label class="fd-radio"><input type="radio"${attrs({ name, value, checked, required })}><span class="fd-radio-box"></span><span class="fd-radio-text"><span class="fd-radio-label">${e(label)}</span>${description ? `<span class="fd-radio-desc">${e(description)}</span>` : ''}</span></label>`;
export const hidden = (name, value) => `<input type="hidden" name="${e(name)}" value="${e(value ?? '')}">`;
const TONE_ICON = { danger: 'circle-alert', warning: 'triangle-alert', success: 'circle-check', info: 'info' };
export const callout = (title, body = '', { tone, role = tone === 'danger' ? 'alert' : 'note' } = {}) =>
    `<div class="fd-callout"${attrs({ 'data-tone': tone, role })}>${icon(TONE_ICON[tone] || 'info').replace('class="fd-icon"', 'class="fd-icon fd-callout-icon"')}<div class="fd-callout-content"><p class="fd-callout-title">${e(title)}</p>${body ? `<p class="fd-callout-body">${e(body)}</p>` : ''}</div></div>`;
// A settings row: title and description on the left, a control (already-safe markup) on the right.
export const setting = (title, description, control = '') => `<div class="fd-setting"><div class="fd-setting-text"><h3 class="fd-setting-title">${e(title)}</h3>${description ? `<p class="fd-setting-desc">${description}</p>` : ''}</div>${control ? `<div class="fd-setting-control">${control}</div>` : ''}</div>`;
// Key-value pairs; values are already-safe markup. fd-kv-value is a flex row, so mixed text and code go in one fd-kv-text.
export const kv = (pairs, cols = 2) => `<dl class="fd-kv" data-cols="${cols}">${pairs.map(([key, value]) => `<div class="fd-kv-item"><dt class="fd-kv-key">${e(key)}</dt><dd class="fd-kv-value"><span class="fd-kv-text">${value}</span></dd></div>`).join('')}</dl>`;
// A list in a card. Each row: { title, desc, meta, trail } where desc, meta and trail are already-safe markup.
export const list = (label, rows) => `<ul class="fd-list" data-card aria-label="${e(label)}">${rows.map(row => `<li class="fd-list-row"><div class="fd-list-body"><span class="fd-list-title">${e(row.title)}</span>${row.desc ? `<span class="fd-list-desc">${row.desc}</span>` : ''}</div>${row.meta ? `<span class="fd-list-meta">${row.meta}</span>` : ''}${row.trail ? `<div class="fd-list-trail">${row.trail}</div>` : ''}</li>`).join('')}</ul>`;
export const empty = (title, text, action = '') => `<div class="fd-empty" data-size="sm"><h3 class="fd-empty-title">${e(title)}</h3><p class="fd-empty-text">${e(text)}</p>${action ? `<div class="fd-empty-actions">${action}</div>` : ''}</div>`;
export const status = (label, tone) => `<span class="fd-status"${attrs({ 'data-tone': tone })}>${e(label)}</span>`;
export const badge = (label, tone) => `<span class="fd-badge"${attrs({ 'data-tone': tone })}>${e(label)}</span>`;
export const code = value => `<code class="fd-code">${e(value)}</code>`;
// A table: headers are text; cells are already-safe markup.
export const table = (label, headers, rows) => `<div class="fd-table-wrap"><div class="fd-table-scroll"><table class="fd-table" aria-label="${e(label)}"><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
export const actions = (...buttons) => `<div class="fd-form-actions">${buttons.join('')}</div>`;
// "or" between two ways to do one thing.
export const orDivider = env => { const or = e(t(env, 'or')); return `<div class="fd-row" data-gap="3" role="separator" aria-label="${or}"><hr class="fd-divider fd-grow"><span class="fd-eyebrow">${or}</span><hr class="fd-divider fd-grow"></div>`; };
export const small = text => `<p class="fd-small fd-muted">${e(text)}</p>`;
