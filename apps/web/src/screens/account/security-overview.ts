import { html, nothing } from 'lit';
import { t, tPlural } from '../../lib/i18n';
import { card } from '../page-layout';
import { empty, list, when } from './access-view';
import { connectionRow } from './connection-row';
import { securityAction } from './security-action';
import { factorRowId, recoveryId, type Factor, type FactorKind, type SecurityChanges } from './security-changes';
import { confirmRowId } from '../confirm-row';
import { menuTrigger } from '../row-menu';
import type { Password } from './security-setup';

interface Passkey extends Factor { backup_eligible: number }
export interface Security { email_verified: boolean; factors: Factor[]; passkeys: Passkey[]; recovery_count: number; password: Password }
export interface Actions {
  start: () => void;
  passkey: () => void;
  password: () => void;
}
export const passwordTitle = ({ updated }: Password) => updated === null ? t('Set a password') : t('Change password');
export const hasSecondFactor = (data: Security) => data.factors.length + data.passkeys.length > 0;

export function overview(data: Security, pending: boolean, actions: Actions, changes: SecurityChanges) {
  pending ||= changes.pending;
  const enabled = data.email_verified, hasFactor = hasSecondFactor(data);
  const last = data.factors.length + data.passkeys.length === 1;
  const passkeysSupported = typeof PublicKeyCredential !== 'undefined';
  const factorActions = (kind: FactorKind, factor: Factor) => {
    const id = factorRowId(kind, factor.id);
    return {
      id, pending: pending || (!enabled && kind === 'authenticator'), busy: changes.holds.has(id),
      confirmation: last ? changes.removalQuestion(kind, factor) : undefined,
      actions: [{ label: t('Remove'), danger: true,
        ...(last ? { confirmRow: confirmRowId(id) } : { run: () => changes.holdRemoval(kind, factor) }) }],
    };
  };
  const emailReason = enabled ? undefined : t('Confirm your email first.');
  const browserReason = passkeysSupported ? undefined : t('This browser cannot add passkeys.');
  const addAuthenticator = securityAction('im-authenticator-reason', t('Add authenticator app'), actions.start, pending, emailReason);
  const addPasskey = securityAction('im-passkey-reason', t('Add passkey'), actions.passkey, pending, emailReason ?? browserReason);
  const passwordDate = data.password.updated, count = data.recovery_count;
  return html`
    ${card(t('Two-step verification'), html`
      <div class="fd-stack" data-gap="5">
        <section class="fd-stack" data-gap="3">
          <h3 class="fd-label">${t('Authenticator apps')}</h3>
          <p class="fd-small fd-muted">${t('Apps that show a new 6-digit code every 30 seconds.')}</p>
          ${data.factors.length ? list(t('Authenticator apps'), data.factors, factor => factor.id, factor => connectionRow({
            ...factorActions('authenticator', factor), title: factor.name,
            description: factor.last_used === null
              ? t('Added {date} · never used', { date: when(factor.created) })
              : t('Added {date} · last used {lastUsed}', { date: when(factor.created), lastUsed: when(factor.last_used) }),
          })) : empty(t('No authenticator app yet'))}
          <div class="fd-row">${addAuthenticator}</div>
        </section>
        <section class="fd-stack" data-gap="3">
          <h3 class="fd-label">${t('Passkeys')}</h3>
          <p class="fd-small fd-muted">${t('Sign in with this device’s screen lock instead of a code.')}</p>
          ${data.passkeys.length ? list(t('Passkeys'), data.passkeys, passkey => passkey.id, passkey => connectionRow({
            ...factorActions('passkey', passkey), title: passkey.name,
            description: t('Added {date}', { date: when(passkey.created) }),
            badge: passkey.backup_eligible ? t('Synced') : undefined,
          })) : empty(t('No passkeys yet'))}
          <div class="fd-row">${addPasskey}</div>
        </section>
      </div>`)}
    ${hasFactor ? card(t('Recovery codes'), html`
      <p class="fd-small">${count ? tPlural(count, '{count} unused code', '{count} unused codes') : t('No unused codes')}</p>
      <div class="fd-row">${securityAction('im-recovery-reason', t('Generate new codes'),
        { id: menuTrigger(recoveryId), confirmRow: confirmRowId(recoveryId) }, pending, emailReason)}</div>
      ${enabled ? changes.recoveryQuestion(count) : nothing}
    `, t('New codes replace every old one.')) : nothing}
    ${card(t('Password'), html`
      <div class="fd-setting"><div class="fd-setting-text">
        <div class="fd-setting-title">${passwordDate === null ? t('None. Apps that offer passwords let you set one.') : t('Set {date}', { date: when(passwordDate) })}</div>
      </div>${enabled ? html`<div class="fd-setting-control">
        <button class="fd-btn" data-variant="outline" type="button" ?disabled=${pending} @click=${actions.password}>${passwordTitle(data.password)}</button>
      </div>` : nothing}</div>`, t('Use it to sign in to apps that offer passwords.'))}`;
}
