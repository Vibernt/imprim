import { html, nothing } from 'lit';
import { t } from '../../../lib/i18n';
import { fieldWithAction, inlineError } from '../../page-layout';
import { roleIds, roleLabel, type Role } from './view';

export type FormAction = (event: SubmitEvent) => void;
export const values = (event: SubmitEvent) => Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement));

export function roleField(id: string, label: string, role: Role, canGrantOwner: boolean) {
  return html`<div class="fd-field">
    <label class="fd-field-label" for=${id}>${label}</label>
    <label class="fd-select"><select id=${id} name="role" required>
      ${roleIds.filter(value => value !== 'owner' || canGrantOwner).map(value => html`
        <option value=${value} ?selected=${value === role}>${roleLabel(value)}</option>`)}
    </select></label>
  </div>`;
}

export function inviteForm(owner: boolean, busy: boolean, submit: FormAction, error?: string) {
  return html`<form class="fd-form" method="post" ?inert=${busy} @submit=${submit}>
    <div class="fd-field">
      <label class="fd-field-label" for="im-workspace-invite-email">${t('Email')}</label>
      <input class="fd-input" type="email" id="im-workspace-invite-email" name="email" required maxlength="254" autocomplete="off">
    </div>
    ${roleField('im-workspace-invite-role', t('Invitation role'), 'member', owner)}
    ${error ? inlineError(error) : nothing}
    <div class="fd-form-actions"><button class="fd-btn" data-variant="primary" type="submit" ?disabled=${busy}>${t('Send invitation')}</button></div>
  </form>`;
}

const cancelButton = (busy: boolean, cancel: () => void) => html`
  <button class="fd-btn" data-variant="ghost" type="button" ?disabled=${busy} @click=${cancel}>${t('Cancel')}</button>`;

export function renameForm(name: string, busy: boolean, submit: FormAction, cancel: () => void) {
  return html`<form class="fd-form" method="post" ?inert=${busy} @submit=${submit}>
    ${fieldWithAction('im-workspace-active-field', t('Workspace name'), undefined, html`
      <input class="fd-input fd-grow" required name="name" id="im-workspace-active-field" .value=${name}>`,
      html`<button class="fd-btn" data-variant="outline" type="submit" ?disabled=${busy}>${t('Save name')}</button>`)}
    <div class="fd-form-actions">${cancelButton(busy, cancel)}</div>
  </form>`;
}

export function changeRoleForm(role: Role, owner: boolean, busy: boolean, submit: FormAction, cancel: () => void) {
  return html`<form class="fd-form" method="post" ?inert=${busy} @submit=${submit}>
    ${roleField('im-workspace-active-field', t('New role'), role, owner)}
    <div class="fd-form-actions">${cancelButton(busy, cancel)}
      <button class="fd-btn" data-variant="outline" type="submit" ?disabled=${busy}>${t('Save role')}</button>
    </div>
  </form>`;
}

export function confirmAction(phrase: string, label: string, busy: boolean, submit: FormAction, cancel: () => void) {
  const name = phrase.trim();
  const [before, after] = t('Type {name} to confirm').split('{name}');
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    if (String(values(event).confirm).trim() === name) submit(event);
  };
  return html`<form class="fd-confirm-inline" method="post" data-fd-confirm-inline data-confirm=${name} ?inert=${busy} @submit=${onSubmit}>
    <div class="fd-field">
      <label class="fd-field-label" for="im-workspace-active-field">${before}<span class="fd-confirm-phrase">${name}</span>${after}</label>
      <input class="fd-input" id="im-workspace-active-field" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false"
        required data-fd-confirm-input aria-describedby="im-workspace-confirm-rule">
      <p class="fd-confirm-inline-rule" id="im-workspace-confirm-rule" data-fd-confirm-rule>${t('Type it exactly as shown. Case counts.')}</p>
    </div>
    <div class="fd-form-actions">${cancelButton(busy, cancel)}
      <button class="fd-btn" data-variant="danger" type="submit" data-fd-confirm-submit disabled>${label}</button>
    </div>
  </form>`;
}
