import { html, nothing } from 'lit';
import { t, tPlural } from '../../lib/i18n';
import { card, fieldWithAction, setting } from '../page-layout';
import { day, empty, list, section } from './access-view';
import type { Password } from './security-setup';

interface Factor { id: string; name: string; created: number; last_used: number | null }
interface Passkey extends Factor { backup_eligible: number }
export interface Security { email_verified: boolean; factors: Factor[]; passkeys: Passkey[]; recovery_count: number; password: Password }
export interface Actions {
  start: () => void;
  passkey: (event: SubmitEvent) => void;
  remove: (kind: 'authenticator' | 'passkey', id: string) => void;
  recovery: () => void;
  password: () => void;
}
export const passwordTitle = ({ updated }: Password) => updated === null ? t('Set a password') : t('Change password');

export function overview(data: Security, pending: boolean, actions: Actions) {
  const enabled = data.email_verified;
  const remove = (kind: 'authenticator' | 'passkey', factor: Factor) => html`
    <button class="fd-btn" data-variant="ghost" data-size="sm" type="button" aria-label=${t('Remove {name}', { name: factor.name })}
      ?disabled=${pending || (!enabled && kind === 'authenticator')} @click=${() => actions.remove(kind, factor.id)}>${t('Remove')}</button>`;
  const passwordDate = data.password.updated;
  const count = data.recovery_count;
  const hasFactor = data.factors.length + data.passkeys.length > 0;
  const factorSummary = [
    data.factors.length ? tPlural(data.factors.length, '{count} authenticator app', '{count} authenticator apps') : '',
    data.passkeys.length ? tPlural(data.passkeys.length, '{count} passkey', '{count} passkeys') : '',
  ].filter(Boolean).join(' · ');
  return html`
    ${card(t('Two-factor authentication'), html`
      ${!enabled ? html`<div class="fd-callout" data-tone="warning" role="status">
        <i class="fd-callout-icon" data-icon="triangle-alert" aria-hidden="true"></i>
        <div class="fd-callout-content"><p class="fd-callout-title">${t('Confirm your email with a sign-in link first.')}</p></div>
      </div>` : nothing}
      ${setting(hasFactor ? factorSummary : t('Ask for a code or passkey when you sign in.'), '',
        hasFactor ? html`<span class="fd-status" data-tone="success">${t('On')}</span>` : html`<span class="fd-status">${t('Off')}</span>`)}
    `)}
    ${section(t('Authenticator apps'), t('Apps that show a new 6-digit code every 30 seconds.'), html`
      ${data.factors.length ? list(t('Authenticator apps'), data.factors.map(f => ({ title: f.name,
        description: `${t('Added {date}', { date: day(f.created) })} · ${f.last_used ? t('last used {date}', { date: day(f.last_used) }) : t('never used')}`,
        trail: remove('authenticator', f),
      }))) : empty(t('No authenticator app yet'), t('Add one to enter a 6-digit code each time you sign in.'))}
      ${enabled ? setting(t('Add an authenticator app'), '', html`
        <button class="fd-btn" data-variant=${hasFactor ? 'outline' : 'primary'} type="button" ?disabled=${pending} @click=${actions.start}>${t('Add authenticator app')}</button>`) : nothing}`)}
    ${section(t('Passkeys'), t('Sign in with this device’s screen lock instead of a code.'), html`
      ${data.passkeys.length ? list(t('Passkeys'), data.passkeys.map(p => ({ title: p.name,
        description: t('Added {date}', { date: day(p.created) }), meta: p.backup_eligible ? html`<span class="fd-badge">${t('Synced')}</span>` : undefined,
        trail: remove('passkey', p),
      }))) : empty(t('No passkeys yet'), t('Add one to use your fingerprint, face or device PIN.'))}
      ${!enabled ? nothing : typeof PublicKeyCredential === 'undefined' ? html`<p class="fd-small fd-muted">${t('This browser cannot add passkeys.')}</p>` : html`
        <form class="fd-form" method="post" @submit=${actions.passkey}>
          ${fieldWithAction('passkey-name', t('Passkey name'), t('Leave blank to name it “Passkey”.'), html`
            <input class="fd-input fd-grow" id="passkey-name" name="name" maxlength="60" placeholder=${t('Work laptop')} aria-describedby="passkey-name-hint">`, html`
            <button class="fd-btn" data-variant="outline" type="submit" ?disabled=${pending}>${t('Add passkey')}</button>`)}
        </form>`}`)}
    ${hasFactor ? section(t('Recovery codes'), t('Each code works once, for when you can’t use your app or passkey.'), html`
      <div class="fd-setting"><div class="fd-setting-text">
        <div class="fd-setting-title">${count ? tPlural(count, '{count} unused code', '{count} unused codes') : t('No unused codes')}</div>
        <div class="fd-setting-desc">${t('New codes replace every old one.')}</div>
      </div>${enabled ? html`<div class="fd-setting-control">
        <button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending} @click=${actions.recovery}>${t('Generate new codes')}</button>
      </div>` : nothing}</div>`) : nothing}
    ${section(t('Password'), t('Use it to sign in to apps that offer passwords.'), html`
      <div class="fd-setting"><div class="fd-setting-text">
        <div class="fd-setting-title">${passwordDate === null ? t('None. Apps that offer passwords let you set one.') : t('Set {date}', { date: day(passwordDate) })}</div>
      </div>${enabled ? html`<div class="fd-setting-control">
        <button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending} @click=${actions.password}>${passwordTitle(data.password)}</button>
      </div>` : nothing}</div>`)}
    ${card(t('Remembered browsers'), setting(t('These skip the second-factor code until the date shown.'), '', html`
      <a class="fd-btn" data-variant="outline" href="/account/sessions">${t('Manage remembered browsers')}</a>`))}`;
}
