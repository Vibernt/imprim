import { html, nothing } from 'lit';
import { forms } from 'fire-design';
import { icon } from '../../lib/icon';

function dateField(name: 'from' | 'to', label: string, value: string, limit: string) {
  const id = 'audit-' + name, calendar = id + '-calendar';
  return html`<div class="fd-field">
    <label class="fd-field-label" for=${id}>${label}</label>
    <div class="fd-datefield" data-fd-datefield
      data-min-date=${name === 'to' && limit ? limit : nothing}
      data-max-date=${name === 'from' && limit ? limit : nothing}>
      <div class="fd-input-group">
        <input class="fd-input" id=${id} name=${name} type="text" inputmode="numeric" autocomplete="off"
          placeholder="2026-12-01" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" .value=${value}>
        <span class="fd-input-affix" data-kind="action">
          <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" data-icon-only
            aria-label=${'Choose date: ' + label} data-fd-popover=${calendar} data-placement="bottom-end">${icon('calendar')}</button>
        </span>
      </div>
      <div class="fd-popover" id=${calendar} popover data-size="auto" aria-label=${'Calendar: ' + label}>
        <div class="fd-datefield-panel" data-fd-datepanel>
          <div class="fd-calendar"></div>
          <div class="fd-datefield-foot">
            <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" data-fd-datepanel-today>Today</button>
            <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" data-fd-datepanel-clear>Clear</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function updateLimits(event: Event) {
  const fields = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-fd-datefield]');
  const [from, to] = fields;
  const start = forms.parseDateText(from.querySelector('input')?.value);
  const end = forms.parseDateText(to.querySelector('input')?.value);
  if (start) to.dataset.minDate = start;
  else delete to.dataset.minDate;
  if (end) from.dataset.maxDate = end;
  else delete from.dataset.maxDate;
  for (const field of fields) forms.checkDateField(field);
}

export function auditDates(from: string, to: string) {
  return html`<div class="fd-stack" data-gap="3" @input=${updateLimits}>
    ${dateField('from', 'From (UTC)', from, to)}
    ${dateField('to', 'Through (UTC)', to, from)}
  </div>`;
}
