import { html } from 'lit';
import { SIGNATURE_CHOICES, SIGNATURE_DEFAULT, SIGNATURE_RANGES } from 'fire-design/theme';
import { cap } from '../realm-ui';
import type { Look } from './types';

type Signature = NonNullable<Look['signature']>;
const [min, max] = SIGNATURE_RANGES.cell;
const cells = Array.from({ length: max - min + 1 }, (_, i) => i + min);

export function signatureFields(look: Look, disabled: boolean, update: (change: Signature) => void) {
  const { cell = SIGNATURE_DEFAULT.cell, ramp = SIGNATURE_DEFAULT.ramp } = look.signature ?? {};
  return html`<div class="fd-grid" data-cols="2" data-min="md" data-gap="3">
    <div class="fd-field">
      <label class="fd-field-label" for="signature-cell">Signature cell size</label>
      <span class="fd-select"><select id="signature-cell" ?disabled=${disabled}
        @change=${(event: Event) => {
          const { value } = event.currentTarget as HTMLSelectElement;
          update({ cell: value === 'auto' ? 'auto' : Number(value) });
        }}>
        <option value="auto" ?selected=${cell === 'auto'}>Auto</option>
        ${cells.map(value => html`<option value=${value} ?selected=${cell === value}>${value}</option>`)}
      </select></span>
    </div>
    <div class="fd-field">
      <label class="fd-field-label" for="signature-ramp">Signature ramp</label>
      <span class="fd-select"><select id="signature-ramp" ?disabled=${disabled}
        @change=${(event: Event) => update({ ramp: (event.currentTarget as HTMLSelectElement).value as Signature['ramp'] })}>
        ${SIGNATURE_CHOICES.ramp.map(value => html`<option value=${value} ?selected=${ramp === value}>${cap(value)}</option>`)}
      </select></span>
    </div>
  </div>`;
}
