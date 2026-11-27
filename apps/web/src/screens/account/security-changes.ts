import type { LitElement } from 'lit';
import type { Send } from '../../lib/api';
import { t, tPlural } from '../../lib/i18n';
import { HeldRows } from '../held';
import { RowConfirmations } from '../row-confirmations';
import { menuTrigger } from '../row-menu';
import { post, success } from './account-screen';

export interface Factor { id: string; name: string; created: number; last_used: number | null }
export type FactorKind = 'authenticator' | 'passkey';
export interface Recovery { recovery_codes: string[] }
export const recoveryId = 'recovery-codes';
export const factorRowId = (kind: FactorKind, id: string) => kind + '-' + id;

export class SecurityChanges {
  readonly confirmation: RowConfirmations;
  readonly holds: HeldRows;

  constructor(
    private readonly host: LitElement,
    private readonly reload: () => Promise<void>,
    private readonly failed: (error: unknown) => void,
    private readonly showCodes: (result: Recovery) => void,
  ) {
    this.confirmation = new RowConfirmations(host, () => t('The request could not be completed.'));
    this.holds = new HeldRows(() => host.requestUpdate());
  }

  get pending() { return this.holds.active || this.confirmation.pending; }

  private removeFactor(kind: FactorKind, factor: Factor, send: Send = {}) {
    return kind === 'authenticator'
      ? post('mfa/remove', { factor_id: factor.id }, send) : post('passkeys/remove', { id: factor.id }, send);
  }

  private async removed(kind: FactorKind) {
    if (!this.host.isConnected) return;
    success(kind === 'authenticator' ? t('Authenticator app removed') : t('Passkey removed'));
    await this.reload();
  }

  holdRemoval(kind: FactorKind, factor: Factor) {
    if (this.pending) return;
    const id = factorRowId(kind, factor.id);
    this.confirmation.clear();
    this.holds.start(id, {
      title: t('Removing {name}', { name: factor.name }),
      run: send => this.removeFactor(kind, factor, send),
      done: () => this.removed(kind),
      failed: this.failed,
    }, async () => {
      await this.host.updateComplete;
      this.host.querySelector<HTMLElement>('#' + CSS.escape(menuTrigger(id)))?.focus();
    });
  }

  removalQuestion(kind: FactorKind, factor: Factor) {
    return this.confirmation.view({
      id: factorRowId(kind, factor.id), text: t('Remove {name}? Two-step verification turns off.', { name: factor.name }),
      action: kind === 'authenticator' ? t('Remove authenticator app') : t('Remove passkey'), cancelLabel: t('Cancel'),
      request: () => this.removeFactor(kind, factor),
      done: () => this.removed(kind),
    });
  }

  recoveryQuestion(count: number) {
    return this.confirmation.view({
      id: recoveryId, text: tPlural(count, 'Your {count} unused code stops working.', 'Your {count} unused codes stop working.'),
      action: t('Generate new codes'), cancelLabel: t('Cancel'),
      request: () => post<Recovery>('mfa/recovery'),
      done: this.showCodes,
    });
  }
}
