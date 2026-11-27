import { html, nothing } from 'lit';
import { t } from '../../lib/i18n';
import { card, fieldWithAction, setting } from '../page-layout';

export interface Profile {
  email: string;
  email_verified: boolean;
  display_name: string | null;
  locale: string | null;
  languages: { id: string; label: string }[];
}

export type Action = 'profile' | 'language' | 'email' | 'delete';
type Submit = (action: Action, event: SubmitEvent) => void;
export type Drafts = Partial<Record<'profile' | 'language', string>>;
interface Editor { drafts: Drafts; change: (field: keyof Drafts, value: string) => void;
  emailOpen: boolean; toggleEmail: (open: boolean) => void }

export function profileFields(profile: Profile, pending: Action | null, submit: Submit, editor: Editor) {
  const disabled = pending !== null;
  const save = (field: keyof Drafts, label: string) => html`${editor.drafts[field] === undefined ||
    (field === 'language' && editor.drafts.profile !== undefined) ? nothing :
    html`<button class="fd-btn" type="submit" data-variant="outline" ?disabled=${disabled}>${label}</button>`}`;
  return html`
    ${setting(t('Email'), html`<span class="fd-mono im-breakable">${profile.email}</span>
      ${profile.email_verified ? nothing : html`<div>${t('Sign in with an email link to confirm it.')}</div>`}`, html`
      <button class="fd-btn" id="im-change-email" data-variant="outline" type="button" aria-expanded=${editor.emailOpen}
        ?disabled=${disabled} @click=${() => editor.toggleEmail(!editor.emailOpen)}>${t('Change email')}</button>`)}
    ${editor.emailOpen ? html`<form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('email', event)}>
      ${fieldWithAction('new_email', t('New email'), t('Needs an email-link sign-in in the last 10 minutes. We confirm the new address and tell the old one.'), html`
        <input class="fd-input fd-grow" id="new_email" name="new_email" type="email" maxlength="254" autocomplete="email"
          placeholder=${t('name@example.com')} aria-describedby="new_email-hint" required ?disabled=${disabled}>`, html`
        <button class="fd-btn" type="submit" data-variant="outline" ?disabled=${disabled}>${t('Send confirmation')}</button>`)}
    </form>` : nothing}
    <div class="fd-stack" data-gap="5">
      <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('profile', event)}>
        ${fieldWithAction('display_name', t('Name'), t('Apps that ask for your profile see this name.'), html`
          <input class="fd-input fd-grow" id="display_name" name="display_name" maxlength="100" autocomplete="name"
            aria-describedby="display_name-hint" .value=${editor.drafts.profile ?? profile.display_name ?? ''} ?disabled=${disabled}
            @input=${(event: Event) => editor.change('profile', (event.currentTarget as HTMLInputElement).value)}>`, save('profile', t('Save name')))}
      </form>
      <form class="fd-form" method="post" @submit=${(event: SubmitEvent) => submit('language', event)}>
        ${fieldWithAction('locale', t('Language'), t('For these pages and the emails we send you.'), html`
          <label class="fd-select fd-grow"><select id="locale" name="locale" aria-describedby="locale-hint" ?disabled=${disabled}
            @change=${(event: Event) => editor.change('language', (event.currentTarget as HTMLSelectElement).value)}>
            <option value="" ?selected=${!(editor.drafts.language ?? profile.locale)}>${t('Automatic')}</option>
            ${profile.languages.map(({ id, label }) => html`<option value=${id} lang=${id} ?selected=${(editor.drafts.language ?? profile.locale) === id}>${label}</option>`)}
          </select></label>`, save('language', t('Save language')))}
      </form>
    </div>`;
}

export function deleteSection(email: string, pending: Action | null, submit: Submit) {
  return card(t('Delete account'), html`
    <div class="fd-setting" data-tone="danger" data-align="start">
      <div class="fd-setting-text">
        <p class="fd-setting-desc">${t('Signs you out of every app and agent and removes how you sign in. It can’t be undone.')}</p>
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
        <div class="fd-row" data-wrap><button class="fd-btn" type="submit" data-variant="danger" data-fd-confirm-submit>${t('Delete account')}</button>
          <p class="fd-small fd-muted">${t('Deleting requires a sign-in in the last 10 minutes.')}</p></div>
      </form>
    </div>`);
}
