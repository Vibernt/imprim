import { html, nothing } from 'lit';
import { t } from '../../lib/i18n';
import { card, fieldWithAction } from '../page-layout';

export interface Profile {
  email: string;
  email_verified: boolean;
  display_name: string | null;
  locale: string | null;
  languages: { id: string; label: string }[];
}

export type Action = 'profile' | 'language' | 'email' | 'delete';
type Submit = (action: Action, event: SubmitEvent) => void;

export function profileFields(profile: Profile, pending: Action | null, submit: Submit) {
  const disabled = pending !== null;
  return html`
    <dl class="fd-kv" data-cols="1">
      <div class="fd-kv-item">
        <dt class="fd-kv-key">${t('Email')}</dt>
        <dd class="fd-kv-value"><span class="fd-kv-text fd-mono">${profile.email}</span></dd>
        ${profile.email_verified ? nothing : html`<dd class="fd-row" data-wrap>
          <span class="fd-badge" data-tone="warning">${t('Not confirmed')}</span>
          <span>${t('Sign in with an email link to confirm it.')}</span>
        </dd>`}
      </div>
    </dl>
    ${card(t('Personal information'), html`<div class="fd-stack" data-gap="5">
      <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('profile', event)}>
        ${fieldWithAction('display_name', t('Name'), t('Apps that ask for your profile see this name.'), html`
          <input class="fd-input fd-grow" id="display_name" name="display_name" maxlength="100" autocomplete="name"
            aria-describedby="display_name-hint" .value=${profile.display_name ?? ''} ?disabled=${disabled}>`, html`
          <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${disabled}>${t('Save name')}</button>`)}
      </form>
      <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('language', event)}>
        ${fieldWithAction('locale', t('Language'), t('For these pages and the emails we send you.'), html`
          <label class="fd-select fd-grow"><select id="locale" name="locale" aria-describedby="locale-hint" ?disabled=${disabled}>
            <option value="" ?selected=${!profile.locale}>${t('Automatic')}</option>
            ${profile.languages.map(({ id, label }) => html`<option value=${id} lang=${id} ?selected=${profile.locale === id}>${label}</option>`)}
          </select></label>`, html`
          <button class="fd-btn" type="submit" ?disabled=${disabled}>${t('Save language')}</button>`)}
      </form>
      <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('email', event)}>
        ${fieldWithAction('new_email', t('New email'), t('Needs an email-link sign-in in the last 10 minutes. We confirm the new address and tell the old one.'), html`
          <input class="fd-input fd-grow" id="new_email" name="new_email" type="email" maxlength="254" autocomplete="email"
            placeholder=${t('name@example.com')} aria-describedby="new_email-hint" required ?disabled=${disabled}>`, html`
          <button class="fd-btn" type="submit" ?disabled=${disabled}>${t('Change email')}</button>`)}
      </form>
    </div>`)}`;
}

export function deleteSection(email: string, pending: Action | null, submit: Submit) {
  return card(t('Delete account'), html`
      <form class="fd-confirm-inline" method="post" data-fd-confirm-inline data-confirm=${email.toLowerCase()}
        @submit=${(event: SubmitEvent) => submit('delete', event)}>
        <div class="fd-field">
          <label class="fd-field-label" for="confirm_email">${t('Your email')}</label>
          <input class="fd-input" id="confirm_email" name="confirm_email" data-fd-confirm-input autocomplete="off"
            spellcheck="false" aria-describedby="confirm-rule" required ?disabled=${pending !== null}
            @input=${(event: Event) => {
              const input = event.currentTarget as HTMLInputElement;
              const lower = input.value.toLowerCase();
              if (input.value !== lower) input.value = lower;
            }}>
          <p class="fd-confirm-inline-rule" id="confirm-rule" data-fd-confirm-rule>${t('Type {email} to confirm.', { email })}</p>
        </div>
        <p class="fd-small fd-muted">${t('Apps keep their own records of you. Deleting needs a sign-in in the last 10 minutes.')}</p>
        <div class="fd-form-actions"><button class="fd-btn" type="submit" data-variant="danger" data-fd-confirm-submit>${t('Delete account')}</button></div>
      </form>
  `, t('Signs you out of every app and agent and removes how you sign in. It can’t be undone.'));
}
