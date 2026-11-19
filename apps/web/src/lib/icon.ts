import { html } from 'lit';
import type { IconName } from 'fire-design';

export const icon = (name: IconName) => html`
  <svg class="fd-icon" data-icon=${name} aria-hidden="true"><use href=${`#i-${name}`}></use></svg>`;
