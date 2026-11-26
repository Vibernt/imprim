import { html, nothing } from 'lit';
import { icon } from '../../../lib/icon';
import { card, fieldWithAction } from '../../page-layout';
import { mono } from '../realm-ui';
import type { Submit, Workspace } from './types';

export function workspaceProducts(workspace: Workspace, pending: boolean, submit: Submit) {
  const change = (event: SubmitEvent) => submit('products', event);
  return card('Products', html`
    ${workspace.products.length ? html`<div class="fd-row" data-wrap data-gap="2">
      ${workspace.products.map(product => html`
        <form method="post" @submit=${change}>
          <span class="fd-tag" data-variant="soft">${mono(product)}
            ${workspace.editable ? html`
              <input type="hidden" name="remove_product" .value=${product}>
              <button class="fd-tag-remove" type="submit" aria-label=${'Remove ' + product} ?disabled=${pending}>${icon('x')}</button>` : nothing}
          </span>
        </form>`)}
    </div>` : html`<p class="fd-muted">No products.</p>`}
    ${workspace.editable ? html`<form class="fd-form" method="post" @submit=${change}>
      ${fieldWithAction('workspace-add-product', 'Product ID', undefined, html`
        <input class="fd-input fd-grow" id="workspace-add-product" name="add_product" data-mono
          autocomplete="off" spellcheck="false" required pattern="[a-z][a-z0-9\\-]{1,39}" placeholder="notes" ?disabled=${pending}>`,
      html`<button class="fd-btn" type="submit" data-variant="outline" ?disabled=${pending}>Add product</button>`)}
    </form>` : nothing}
  `);
}
