import { html, nothing, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { overlays } from 'fire-design';
import { icon } from '../../lib/icon';
import { auditDates } from './audit-dates';
import { text } from './core-fields';
import { eventLabel, eventLabels } from './audit-events';

type Change = (filters: Record<string, string>) => void;
const field = (data: FormData, name: string) => String(data.get(name) ?? '');

function chip(id: string, label: string, value: string, controls: TemplateResult,
  apply: (data: FormData) => void, clear: () => void) {
  return html`<div class="fd-filter" ?data-active=${Boolean(value)} data-default=${label}
    @fd:change=${(event: CustomEvent<{ value: string | null }>) => { if (event.detail.value === null) clear(); }}>
    <button class="fd-filter-trigger" type="button" data-fd-popover=${id} aria-expanded="false">
      <span class="fd-filter-value">${value || label}</span>
      <i class="fd-filter-chevron" data-icon="chevron-down" data-size="14" aria-hidden="true"></i>
    </button>
    ${value ? html`<button class="fd-filter-clear" type="button" aria-label=${'Clear ' + label.toLowerCase()}>${icon('x')}</button>` : nothing}
  </div>
  <div class="fd-popover" id=${id} popover aria-label=${'Filter by ' + label.toLowerCase()}>
    <form class="fd-stack" data-gap="3" method="get" @submit=${(event: SubmitEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      overlays.closePopover(id);
      apply(new FormData(event.currentTarget as HTMLFormElement));
    }}>
      ${controls}
      <div class="fd-row"><button class="fd-btn" type="submit">Apply</button></div>
    </form>
  </div>`;
}

export function auditFilters(query: URLSearchParams, change: Change) {
  const sortedEvents = Object.keys(eventLabels).map(key => ({ key, label: eventLabel(key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const event = query.get('event') ?? '', from = query.get('from') ?? '', to = query.get('to') ?? '';
  const actor = query.get('actor') ?? '', target = query.get('target') ?? '';
  const subject = [actor && 'Actor: ' + actor, target && 'Target: ' + target].filter(Boolean).join(', ');
  const range = from && to ? from + ' to ' + to : from ? 'From ' + from : to ? 'Through ' + to : '';
  // Rebuild the chips only when a filter's value changes, never on paging or an unrelated redraw such as the list
  // loading, which would close a filter someone has open.
  return keyed(JSON.stringify([event, from, to, actor, target]), html`<div class="fd-toolbar"><div class="fd-toolbar-filters" role="group" aria-label="Filters">
    ${chip('audit-event-filter', 'Event type', eventLabel(event), html`
      <div class="fd-field">
        <label class="fd-field-label" for="audit-event">Event type</label>
        <label class="fd-select"><select name="event" id="audit-event">
          <option value="">All events</option>
          ${event && !Object.hasOwn(eventLabels, event) ? html`<option selected>${event}</option>` : nothing}
          ${sortedEvents.map(({ key, label }) => html`<option value=${key} ?selected=${event === key}>${label}</option>`)}
        </select></label>
      </div>`, data => change({ event: field(data, 'event') }), () => change({ event: '' }))}
    ${chip('audit-time-filter', 'Time range', range, auditDates(from, to),
      data => change({ from: field(data, 'from'), to: field(data, 'to') }), () => change({ from: '', to: '' }))}
    ${chip('audit-subject-filter', 'Subject', subject, html`
      ${text({ id: 'audit-actor', label: 'Actor ID', name: 'actor', value: actor, mono: true })}
      ${text({ id: 'audit-target', label: 'Target ID', name: 'target', value: target, mono: true })}`,
      data => change({ actor: field(data, 'actor'), target: field(data, 'target') }), () => change({ actor: '', target: '' }))}
  </div></div>`);
}
