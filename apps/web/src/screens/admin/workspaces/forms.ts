import { html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { cap, field, formSection } from '../realm-ui';
import type { Role, Submit } from './types';

export const nameField = (value = '') => field('workspace-name', 'Workspace name', { name: 'name', value, required: true, max: 120 });

export const productField = (name: string, label: string) => keyed(name, html`
  <div class="fd-field">
    <label class="fd-field-label" for=${'workspace-' + name}>${label}</label>
    <div class="fd-tag-input" data-fd-tag-input data-mono data-pattern="^[a-z][a-z0-9-]{1,39}$" data-format="json">
      <textarea id=${'workspace-' + name} name=${name} rows="2" placeholder="notes"></textarea>
    </div>
  </div>`);

export const roleField = (id: string, label: string, role: Role, canGrantOwner: boolean) => html`
  <div class="fd-field">
    <label class="fd-field-label" for=${id}>${label}</label>
    <span class="fd-select"><select id=${id} name="role">
      ${(canGrantOwner ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer']).map(value => html`
        <option value=${value} ?selected=${role === value}>${cap(value)}</option>`)}
    </select></span>
  </div>`;

export const submitButton = (title: string) => html`
  <div class="fd-row"><button class="fd-btn" type="submit" data-variant="outline">${title}</button></div>`;

export const createForm = (pending: boolean, submit: Submit) => html`
  <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('create', event)}>
    <fieldset class="fd-stack im-fieldset" data-gap="4" ?disabled=${pending}>
      ${formSection('workspace-create-team', 'Team', html`${nameField()}${productField('products', 'Products')}`)}
      ${formSection('workspace-create-owner', 'First owner', field('first_owner_email', 'First owner email',
        { type: 'email', required: true, max: 254 }),
      'If you enter a different email, Imprim sends an invitation.') }
      <div class="fd-form-actions"><button class="fd-btn" type="submit" data-variant="primary">Create workspace</button></div>
    </fieldset>
  </form>`;
