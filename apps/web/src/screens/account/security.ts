import { focusQuiet } from 'fire-design';
import { ApiError, api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { AccountScreen, post, success } from './account-screen';
import { hasSecondFactor, overview, passwordTitle, type Actions, type Security } from './security-overview';
import { setupView, passwordView, recoveryView, type Setup } from './security-setup';
import { createPasskey, namePasskey, type AddedPasskey } from './security-passkeys';

interface Recovery { recovery_codes: string[] }
type Step = { setup: Setup } | { recovery: string[]; regenerated: boolean } | { passkey: AddedPasskey } | 'password';

class ScreenSecurity extends AccountScreen<Security> {
  static override properties = { step: { state: true } };
  declare private step: Step | undefined;
  private code = '';
  private passkeyRequest?: AbortController;

  protected override read() {
    return api<Security>('/v1/account/security');
  }

  override disconnectedCallback() {
    this.passkeyRequest?.abort();
    this.step = undefined;
    super.disconnectedCallback();
  }

  private show(step?: Step) {
    this.code = '';
    this.step = step;
    void this.updateComplete.then(() => {
      const heading = this.querySelector('h1');
      if (heading) focusQuiet(heading);
    });
  }

  private done = () => {
    this.show();
    void this.load();
  };

  private showCodes(result: Recovery, regenerated: boolean) {
    if (!this.isConnected) return;
    if (result.recovery_codes.length) this.show({ recovery: result.recovery_codes, regenerated });
    else this.done();
  }

  private confirm = (event: SubmitEvent) => {
    event.preventDefault();
    if (!this.step || typeof this.step !== 'object' || !('setup' in this.step)) return;
    const { factor_id } = this.step.setup;
    const fields = new FormData(event.currentTarget as HTMLFormElement);
    const code = this.code;
    void this.mutate(async () => {
      const result = await post<Recovery>('mfa/confirm', { factor_id, name: fields.get('name'), code });
      if (this.isConnected) success(t('Two-factor authentication is on'));
      this.showCodes(result, false);
    });
  };

  private savePassword = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = Object.fromEntries(new FormData(form));
    void this.mutate(async () => {
      await post('password', body);
      if (!this.isConnected) return;
      form.reset();
      success(t('Password saved'), t('Your other sessions were signed out.'));
      this.done();
    });
  };

  private actions: Actions = {
    start: () => this.mutate(async () => {
      const setup = await post<Setup>('mfa/start');
      if (this.isConnected) this.show({ setup });
    }),
    passkey: () => {
      void this.mutate(async () => {
        const controller = this.passkeyRequest = new AbortController();
        try {
          const result = await createPasskey(controller.signal).catch((error: unknown) => {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, 'passkey_failed', t('The passkey step didn’t finish. Try again.'));
          });
          if (this.isConnected) {
            success(t('Passkey added'));
            this.show({ passkey: result });
          }
        } finally {
          this.passkeyRequest = undefined;
        }
      });
    },
    remove: (kind, id) => this.mutate(async () => {
      if (kind === 'authenticator') await post('mfa/remove', { factor_id: id });
      else await post('passkeys/remove', { id });
      if (!this.isConnected) return;
      success(kind === 'authenticator' ? t('Authenticator app removed') : t('Passkey removed'));
      await this.load(false);
    }),
    recovery: () => this.mutate(async () => this.showCodes(await post<Recovery>('mfa/recovery'), true)),
    password: () => this.show('password'),
  };

  private savePasskeyName(passkey: AddedPasskey, event: SubmitEvent) {
    event.preventDefault();
    const name = new FormData(event.currentTarget as HTMLFormElement).get('name');
    return this.mutate(async () => {
      await post('passkeys/rename', { id: passkey.id, name });
      this.showCodes(passkey, false);
    });
  }

  protected override render() {
    if (this.step === 'password' && this.data) return this.page(passwordTitle(this.data.password), t('Use it to sign in to apps that offer passwords.'),
      data => passwordView(data.password, this.pending, () => this.show(), this.savePassword));
    const step = this.step;
    if (step && typeof step === 'object') {
      if ('setup' in step) return this.page(t('Add an authenticator app'), t('Scan the code, then enter the 6-digit code your app shows.'),
        () => setupView(step.setup, this.pending, () => this.show(), this.confirm, event => { this.code = event.detail.value; }));
      if ('passkey' in step) return this.page(t('Name your passkey'), '',
        () => namePasskey(step.passkey, this.pending, event => this.savePasskeyName(step.passkey, event), () => this.showCodes(step.passkey, false)));
      return this.page(step.regenerated ? t('New recovery codes') : t('Save these recovery codes now'),
        step.regenerated ? t('Your old codes stopped working. Save these before you leave.') : t('They are shown once. Each code signs you in one time.'),
        () => recoveryView(step.recovery, this.done));
    }
    const status = this.data ? (hasSecondFactor(this.data) ? t('Two-step sign-in is on.') : t('Two-step sign-in is off.')) : '';
    return this.page(t('Security'), status, data => overview(data, this.pending, this.actions));
  }
}
customElements.define('screen-security', ScreenSecurity);
