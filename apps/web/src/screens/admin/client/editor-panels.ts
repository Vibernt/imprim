import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { icon } from '../../../lib/icon';
import { checkbox } from '../core-fields';
import { card, confirmPhrase, facts, mono, status, table } from '../core-view';
import type { Client, Delivery } from './model';

export const secretPanel = (secret: string, dismiss: () => void) => card('Copy the new client secret', html`
  <div class="fd-stack" data-gap="3">
    ${keyed(secret, html`
      <div class="fd-secret" data-value=${secret} data-mask="full" data-noun="client secret" role="group" aria-label="New client secret">
        <code class="fd-secret-value"></code>
        <div class="fd-secret-actions">
          <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" data-icon-only
            data-fd-field-action="reveal" aria-label="Show client secret">${icon('eye')}</button>
          <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" data-icon-only
            data-fd-field-action="copy" aria-label="Copy client secret">${icon('copy')}</button>
        </div>
      </div>`)}
    <div class="fd-row">
      <button class="fd-btn" type="button" data-variant="primary" @click=${dismiss}>Done</button>
    </div>
  </div>`, 'Store it in your app’s secrets. It is shown once.');

export function rotationPanel(client: Client, confirming: boolean, pending: boolean, review: (open: boolean) => void, rotate: (convert: boolean) => void) {
  return card('Client secret',
    confirming ? confirmPhrase({
      id: 'confirm-client-rotation', phrase: client.id, label: 'Type the client ID', action: 'Rotate secret', pending,
      cancel: () => review(false), submit: (_, form) => rotate(form.get('make_confidential') === 'true'),
      fields: client.confidential ? undefined : checkbox('make_confidential', 'Make this public client confidential', false, 'true', true),
    }) : html`<div class="fd-row">
      <button class="fd-btn" type="button" data-variant="outline" ?disabled=${pending} @click=${() => review(true)}>Review secret rotation</button>
    </div>`, 'Rotating stops the current secret. Needs a sign-in in the last 10 minutes.');
}

export const deliveryPanel = (delivery: Delivery) => card('Back-channel delivery', html`
  ${facts([['Undelivered', delivery.counts.undelivered], ['Expired', delivery.counts.expired]])}
  ${delivery.events.length ? table('Back-channel events', ['Kind', 'Event', 'State', 'Last error'],
    delivery.events.map(event => [event.kind, mono(event.id), status(event.delivery_state, event.delivery_state === 'expired' ? 'danger' : 'warning'),
      event.last_error || 'None'])) : nothing}
`, 'Signed events waiting for this app, retried for 24 hours.');
