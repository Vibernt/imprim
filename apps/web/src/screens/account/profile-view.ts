import { html, nothing, type TemplateResult } from 'lit';
import { t } from '../../lib/i18n';

export interface Profile {
  email: string;
  email_verified: boolean;
  display_name: string | null;
  locale: string | null;
  languages: { id: string; label: string }[];
}

export type Action = 'profile' | 'language' | 'email' | 'delete';
type Submit = (action: Action, event: SubmitEvent) => void;

function row(id: string, label: string, description: string, input: TemplateResult, button: TemplateResult) {
  return html`
    <div class="fd-form-row" data-layout="stack">
      <div class="fd-form-row-text">
        <label class="fd-form-row-label" for=${id}>${label}</label>
        <span class="fd-form-row-desc" id=${`${id}-desc`}>${description}</span>
      </div>
      <div class="fd-form-row-control"><div class="fd-field"><div class="fd-input-pair">${input}${button}</div></div></div>
    </div>`;
}

export function profileFields(profile: Profile, pending: Action | null, submit: Submit) {
  const disabled = pending !== null;
  return html`
    <div class="fd-form-row" data-layout="stack">
      <div class="fd-form-row-text"><span class="fd-form-row-label">${t('Email')}</span></div>
      <div class="fd-form-row-control">
        <span class="fd-mono">${profile.email}</span>
        ${profile.email_verified ? nothing : html`
          <span class="fd-badge" data-tone="warning">${t('Not confirmed')}</span>
          <span>${t('Sign in with an email link to confirm it.')}</span>`}
      </div>
    </div>
    <form method="post" @submit=${(event: SubmitEvent) => submit('profile', event)}>
      ${row('display_name', t('Name'), t('Apps that ask for your profile see this name.'), html`
        <input class="fd-input" id="display_name" name="display_name" maxlength="100" autocomplete="name"
          aria-describedby="display_name-desc" .value=${profile.display_name ?? ''} ?disabled=${disabled}>`, html`
        <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${disabled}>${t('Save name')}</button>`)}
    </form>
    <form method="post" @submit=${(event: SubmitEvent) => submit('language', event)}>
      ${row('locale', t('Language'), t('For these pages and the emails we send you.'), html`
        <span class="fd-select"><select id="locale" name="locale" aria-describedby="locale-desc" ?disabled=${disabled}>
          <option value="" ?selected=${!profile.locale}>${t('Automatic')}</option>
          ${profile.languages.map(({ id, label }) => html`<option value=${id} lang=${id} ?selected=${profile.locale === id}>${label}</option>`)}
        </select></span>`, html`
        <button class="fd-btn" type="submit" ?disabled=${disabled}>${t('Save language')}</button>`)}
    </form>
    <form method="post" @submit=${(event: SubmitEvent) => submit('email', event)}>
      ${row('new_email', t('New email'), t('Needs an email-link sign-in in the last 10 minutes. We confirm the new address and tell the old one.'), html`
        <input class="fd-input" id="new_email" name="new_email" type="email" maxlength="254" autocomplete="email"
          placeholder=${t('name@example.com')} aria-describedby="new_email-desc" required ?disabled=${disabled}>`, html`
        <button class="fd-btn" type="submit" ?disabled=${disabled}>${t('Change email')}</button>`)}
    </form>`;
}

export function deleteSection(email: string, pending: Action | null, submit: Submit) {
  return html`
    <section class="fd-stack" data-gap="3" aria-labelledby="delete-heading">
      <div class="fd-stack" data-gap="1">
        <h2 class="fd-h3" id="delete-heading">${t('Delete account')}</h2>
        <p class="fd-small fd-muted">${t('Signs you out of every app and agent and removes how you sign in. It can’t be undone.')}</p>
      </div>
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
    </section>`;
}
