import { html } from 'lit';
import { SIGNATURE_CHOICES, SIGNATURE_DEFAULT, SIGNATURE_RANGES } from 'fire-design/theme';
import { cap } from '../realm-ui';
import type { Look } from './types';

type Signature = NonNullable<Look['signature']>;
const [min, max] = SIGNATURE_RANGES.cell;
const cells = Array.from({ length: max - min + 1 }, (_, i) => i + min);

export function signatureFields(look: Look, disabled: boolean, update: (change: Signature) => void) {
  const { cell = SIGNATURE_DEFAULT.cell, ramp = SIGNATURE_DEFAULT.ramp } = look.signature ?? {};
  return html`<div>
    <div class="fd-setting">
      <div class="fd-setting-text">
        <label class="fd-setting-title" for="signature-cell">Texture character size</label>
        <p class="fd-setting-desc" id="signature-cell-hint">Larger characters make the background texture coarser.</p>
      </div>
      <div class="fd-setting-control"><label class="fd-select" data-fit><select id="signature-cell" aria-describedby="signature-cell-hint" ?disabled=${disabled}
        @change=${(event: Event) => {
          const { value } = event.currentTarget as HTMLSelectElement;
          update({ cell: value === 'auto' ? 'auto' : Number(value) });
        }}>
        <option value="auto" ?selected=${cell === 'auto'}>Auto</option>
        ${cells.map(value => html`<option value=${value} ?selected=${cell === value}>${value}</option>`)}
      </select></label></div>
    </div>
    <div class="fd-setting">
      <div class="fd-setting-text">
        <label class="fd-setting-title" for="signature-ramp">Texture character set</label>
        <p class="fd-setting-desc" id="signature-ramp-hint">Changes the symbols used to draw the background texture.</p>
      </div>
      <div class="fd-setting-control"><label class="fd-select" data-fit><select id="signature-ramp" aria-describedby="signature-ramp-hint" ?disabled=${disabled}
        @change=${(event: Event) => update({ ramp: (event.currentTarget as HTMLSelectElement).value as Signature['ramp'] })}>
        ${SIGNATURE_CHOICES.ramp.map(value => html`<option value=${value} ?selected=${ramp === value}>${cap(value)}</option>`)}
      </select></label></div>
    </div>
  </div>`;
}
