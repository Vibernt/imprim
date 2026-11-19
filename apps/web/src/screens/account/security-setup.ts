import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { t } from '../../lib/i18n';
import { formSection } from '../page-layout';

export interface Setup { factor_id: string; name: string; secret: string; qr: string }
export interface Password { updated: number | null; current_password_required: boolean }

export function setupView(setup: Setup, pending: boolean, cancel: () => void, submit: (event: SubmitEvent) => void, otpChanged: (event: CustomEvent<{ value: string }>) => void) {
  return html`
    <form method="post" class="fd-form" data-size="full" @submit=${submit}>
      ${formSection('authenticator-setup', t('Authenticator setup code'), html`
        <figure class="fd-qr" aria-label=${t('Authenticator setup code')}>
          <img src=${`data:image/svg+xml,${encodeURIComponent(setup.qr)}`} alt=${t('Authenticator setup code')}>
        </figure>
        <div class="fd-stack" data-gap="2">
          <p class="fd-small fd-muted">${t('Can’t scan it? Enter this setup key in the app instead.')}</p>
          ${keyed(setup.factor_id, html`<div class="fd-secret" data-fd-secret data-mask="full" data-noun=${t('setup key')}>
            <code class="fd-secret-value">${setup.secret}</code>
            <div class="fd-secret-actions">
              <button class="fd-btn" data-variant="ghost" data-size="sm" data-icon-only type="button" data-fd-field-action="reveal" aria-label=${t('Show setup key')}><fd-icon icon="eye"></fd-icon></button>
              <button class="fd-btn" data-variant="ghost" data-size="sm" data-icon-only type="button" data-fd-field-action="copy" aria-label=${t('Copy setup key')}><fd-icon icon="copy"></fd-icon></button>
            </div>
          </div>`)}
        </div>

        <div class="fd-field">
          <label class="fd-field-label" for="totp-name">${t('Name')}</label>
          <input class="fd-input" id="totp-name" name="name" .value=${setup.name} maxlength="60" required aria-describedby="totp-name-hint">
          <p class="fd-field-hint" id="totp-name-hint">${t('Shown in your list, so you can tell your apps apart.')}</p>
        </div>
        <div class="fd-field">
          <label class="fd-field-label" for="totp-code" id="totp-code-label">${t('Code')}</label>
          ${keyed(setup.factor_id, html`<div class="fd-otp" data-size="sm" data-fd-otp data-length="6" role="group" aria-labelledby="totp-code-label" @fd:change=${otpChanged}>
            <input class="fd-input" id="totp-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
          </div>`)}
        </div>
      `)}
      <div class="fd-form-actions">
        <button class="fd-btn" data-variant="ghost" type="button" ?disabled=${pending} @click=${cancel}>${t('Cancel')}</button>
        <button class="fd-btn" data-variant="primary" type="submit" ?disabled=${pending}>${t('Add authenticator app')}</button>
      </div>
    </form>`;
}

export function recoveryView(codes: string[], done: () => void) {
  return html`
    ${keyed(codes, html`<section class="fd-codes" data-fd-codes data-filename="imprim-recovery-codes.txt">
      <div class="fd-codes-head">
        <h2 class="fd-codes-title">${t('Recovery codes')}</h2>
        <div class="fd-codes-actions">
          <button class="fd-btn" data-variant="outline" data-size="sm" data-fd-codes-copy type="button">${t('Copy all')}</button>
          <button class="fd-btn" data-variant="outline" data-size="sm" data-fd-codes-download type="button">${t('Download')}</button>
        </div>
      </div>
      <ol class="fd-codes-list">${codes.map(code => html`<li class="fd-codes-item"><code>${code}</code></li>`)}</ol>
      <p class="fd-codes-note">${t('Keep them in a password manager or somewhere offline. Anyone with a code can pass this step.')}</p>
    </section>`)}
    <div class="fd-row"><button class="fd-btn" data-variant="primary" type="button" @click=${done}>${t('Done')}</button></div>`;
}

function passwordField(id: 'current_password' | 'password', label: string) {
  const current = id === 'current_password';
  return html`<div class="fd-field">
    <label class="fd-field-label" for=${id}>${label}</label>
    <div class="fd-secret" data-mode="entry" data-noun=${t('password')}>
      <input class="fd-secret-input" id=${id} name=${id} type="password" autocomplete=${current ? 'current-password' : 'new-password'}
        required minlength=${current ? nothing : '12'} maxlength=${current ? nothing : '128'} aria-describedby=${current ? nothing : 'password-hint'}>
      <div class="fd-secret-actions">
        <button class="fd-btn" data-variant="ghost" data-size="sm" data-icon-only type="button" data-fd-field-action="reveal" aria-label=${t('Show password')}><fd-icon icon="eye"></fd-icon></button>
      </div>
    </div>
    ${current ? nothing : html`<p class="fd-field-hint" id="password-hint">${t('12 to 128 characters. A few unrelated words work well.')}</p>`}
  </div>`;
}

export function passwordView(password: Password, pending: boolean, cancel: () => void, submit: (event: SubmitEvent) => void) {
  return keyed(password.current_password_required, html`<form class="fd-form" data-size="full" method="post" @submit=${submit}>
    ${formSection('password-setup', t('Password'), html`
      ${password.current_password_required ? passwordField('current_password', t('Current password')) : nothing}
      ${passwordField('password', t('New password'))}
      <p class="fd-small fd-muted">${t('We check new passwords against known data breaches. Saving signs out your other sessions and forgets remembered browsers.')}</p>
    `)}
    <div class="fd-form-actions">
      <button class="fd-btn" type="button" data-variant="ghost" ?disabled=${pending} @click=${cancel}>${t('Cancel')}</button>
      <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${pending}>${t('Save password')}</button>
    </div>
  </form>`);
}
