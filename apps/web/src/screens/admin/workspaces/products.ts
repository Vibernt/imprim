import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { icon } from '../../../lib/icon';
import { card, fieldWithAction } from '../../page-layout';
import { mono } from '../realm-ui';
import type { Controls, Workspace } from './types';

export function workspaceProducts(workspace: Workspace, { pending, submit, busy, hold }: Controls) {
  return card('Products', html`
    ${workspace.products.length ? html`<div class="fd-row" data-wrap data-gap="2">
      ${repeat(workspace.products, product => product, product => {
        const id = 'workspace-product-' + product;
        // Fire removes a tag on its remove button unless fd:close is cancelled; the held toast decides instead.
        return html`<span class="fd-tag" data-variant="soft" aria-busy=${busy(id) ? 'true' : nothing}
          @fd:close=${(event: Event) => event.preventDefault()}>${mono(product)}
          ${workspace.editable ? html`<button class="fd-tag-remove" type="button" id=${id}
            aria-label=${'Remove ' + product} ?disabled=${pending || busy(id)}
            @click=${() => hold(id, 'Removing ' + product, 'products', { add: [], remove: [product] }, id)}>${icon('x')}</button>` : nothing}
        </span>`;
      })}
    </div>` : html`<p class="fd-muted">No products.</p>`}
    ${workspace.editable ? html`<form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('products', event)}>
      ${fieldWithAction('workspace-add-product', 'Product ID', undefined, html`
        <input class="fd-input fd-grow" id="workspace-add-product" name="add_product" data-mono
          autocomplete="off" spellcheck="false" required pattern="[a-z][a-z0-9\\-]{1,39}" placeholder="notes" ?disabled=${pending}>`,
      html`<button class="fd-btn" type="submit" data-variant="outline" ?disabled=${pending}>Add product</button>`)}
    </form>` : nothing}
  `);
}
