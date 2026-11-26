import { html, nothing } from 'lit';
import { t, tPlural } from '../../lib/i18n';
import { card, setting } from '../page-layout';
import { empty, list, section, when } from './access-view';
import type { Password } from './security-setup';

interface Factor { id: string; name: string; created: number; last_used: number | null }
interface Passkey extends Factor { backup_eligible: number }
export interface Security { email_verified: boolean; factors: Factor[]; passkeys: Passkey[]; recovery_count: number; password: Password }
export interface Actions {
  start: () => void;
  passkey: () => void;
  remove: (kind: 'authenticator' | 'passkey', id: string) => void;
  recovery: () => void;
  password: () => void;
}
export const passwordTitle = ({ updated }: Password) => updated === null ? t('Set a password') : t('Change password');
export const hasSecondFactor = (data: Security) => data.factors.length + data.passkeys.length > 0;

export function overview(data: Security, pending: boolean, actions: Actions) {
  const enabled = data.email_verified, hasFactor = hasSecondFactor(data);
  const passkeysSupported = typeof PublicKeyCredential !== 'undefined';
  const remove = (kind: 'authenticator' | 'passkey', factor: Factor) => html`
    <button class="fd-btn" data-variant="outline" data-size="sm" type="button" aria-label=${t('Remove {name}', { name: factor.name })}
      ?disabled=${pending || (!enabled && kind === 'authenticator')} @click=${() => actions.remove(kind, factor.id)}>${t('Remove')}</button>`;
  const addAuthenticator = html`<button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending || !enabled}
    @click=${actions.start}>${t('Add authenticator app')}</button>`;
  const addPasskey = html`<button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending || !enabled || !passkeysSupported}
    @click=${actions.passkey}>${t('Add passkey')}</button>`;
  const authenticatorDescription = t('Apps that show a new 6-digit code every 30 seconds.');
  const passkeyDescription = t('Sign in with this device’s screen lock instead of a code.');
  const browserNote = passkeysSupported ? nothing : html`<p class="fd-small fd-muted">${t('This browser cannot add passkeys.')}</p>`;
  const passwordDate = data.password.updated, count = data.recovery_count;
  return html`
    ${!enabled ? html`<div class="fd-callout" data-tone="warning" role="status">
      <i class="fd-callout-icon" data-icon="triangle-alert" aria-hidden="true"></i>
      <div class="fd-callout-content"><p class="fd-callout-title">${t('Confirm your email with a sign-in link first.')}</p></div>
    </div>` : nothing}
    ${hasFactor ? html`
      ${card(t('Two-factor authentication'), html`
        <p class="fd-small fd-muted">${[
          tPlural(data.factors.length, '{count} authenticator app', '{count} authenticator apps'),
          tPlural(data.passkeys.length, '{count} passkey', '{count} passkeys'),
        ].join(' · ')}</p>
        ${setting(t('Recovery codes'), html`<span>${count ? tPlural(count, '{count} unused code', '{count} unused codes') : t('No unused codes')}</span>
          <div>${t('New codes replace every old one.')}</div>`, html`
          <button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending || !enabled}
            @click=${actions.recovery}>${t('Generate new codes')}</button>`)}`)}
      ${section(t('Authenticator apps'), authenticatorDescription, html`
        ${data.factors.length ? list(t('Authenticator apps'), data.factors.map(factor => ({ title: factor.name,
          description: `${t('Added {date}', { date: when(factor.created) })} · ${factor.last_used ? t('last used {date}', { date: when(factor.last_used) }) : t('never used')}`,
          trail: remove('authenticator', factor),
        }))) : empty(t('No authenticator app yet'))}
        <div class="fd-row">${addAuthenticator}</div>`)}
      ${section(t('Passkeys'), passkeyDescription, html`
        ${data.passkeys.length ? list(t('Passkeys'), data.passkeys.map(passkey => ({ title: passkey.name,
          description: t('Added {date}', { date: when(passkey.created) }),
          meta: passkey.backup_eligible ? html`<span class="fd-badge">${t('Synced')}</span>` : undefined,
          trail: remove('passkey', passkey),
        }))) : empty(t('No passkeys yet'))}
        <div class="fd-row" data-wrap>${addPasskey}${browserNote}</div>`)}
    ` : html`<div class="fd-card-grid">
      ${section(t('Authenticator app'), authenticatorDescription, html`<div class="fd-row">${addAuthenticator}</div>`)}
      ${section(t('Passkey'), passkeyDescription, html`<div class="fd-row" data-wrap>${addPasskey}${browserNote}</div>`)}
    </div>`}
    ${section(t('Password'), t('Use it to sign in to apps that offer passwords.'), html`
      <div class="fd-setting"><div class="fd-setting-text">
        <div class="fd-setting-title">${passwordDate === null ? t('None. Apps that offer passwords let you set one.') : t('Set {date}', { date: when(passwordDate) })}</div>
      </div>${enabled ? html`<div class="fd-setting-control">
        <button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending} @click=${actions.password}>${passwordTitle(data.password)}</button>
      </div>` : nothing}</div>`)}`;
}
