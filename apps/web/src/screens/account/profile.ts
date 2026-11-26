import { html, nothing, type TemplateResult } from 'lit';
import { overlays } from 'fire-design';
import { ApiError, api } from '../../lib/api';
import { FireLight } from '../../lib/fire-light';
import { t } from '../../lib/i18n';
import { deleteSection, profileFields, type Action, type Drafts, type Profile } from './profile-view';
import { pageHead } from '../page-layout';

const { toast } = overlays;
const describe = (error: unknown) => error instanceof ApiError ? error.description : t('The request could not be completed.');

class ScreenProfile extends FireLight {
  static override properties = {
    profile: { state: true }, pending: { state: true }, loadError: { state: true }, drafts: { state: true },
    emailOpen: { state: true },
  };
  declare private profile: Profile | undefined;
  declare private pending: Action | null;
  declare private loadError: string | undefined;
  declare private drafts: Drafts;
  declare private emailOpen: boolean;

  constructor() {
    super();
    this.pending = null;
    this.drafts = {};
    this.emailOpen = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.loadError = undefined;
    try {
      this.profile = await api<Profile>('/v1/account/profile');
      if (this.isConnected) this.showReturnNotice();
    } catch (error) {
      if (!(error instanceof ApiError && error.redirecting)) this.loadError = describe(error);
    }
  }

  private showReturnNotice() {
    const url = new URL(location.href);
    const changed = url.searchParams.get('changed');
    if (changed === 'email') {
      toast({ title: t('Email changed'), description: t('Sign in with your new address from now on.'), tone: 'success' });
    } else if (changed === 'language') {
      toast({ title: t('Language saved'), tone: 'success' });
    } else return;
    url.searchParams.delete('changed');
    history.replaceState(history.state, '', url);
  }

  private submit = async (action: Action, event: SubmitEvent) => {
    event.preventDefault();
    if (this.pending || !this.profile) return;
    if (action === 'profile' && this.drafts.profile === undefined) return;
    if (action === 'language' && (this.drafts.language === undefined || this.drafts.profile !== undefined)) return;
    const form = event.currentTarget as HTMLFormElement;
    const body = Object.fromEntries(new FormData(form));
    let emailSent = false;
    this.pending = action;
    try {
      const options = { method: 'POST', body };
      if (action === 'profile') {
        const result = await api<Pick<Profile, 'display_name'>>('/v1/account/profile', options);
        this.profile = { ...this.profile, ...result };
        const field = form.elements.namedItem('display_name') as HTMLInputElement;
        field.value = result.display_name ?? '';
        this.change('profile', field.value);
        toast({ title: t('Name saved'), tone: 'success' });
      } else if (action === 'email') {
        const result = await api<{ title: string; body: string }>('/v1/account/email', options);
        emailSent = true;
        toast({ title: result.title, description: result.body, tone: 'success' });
      } else if (action === 'language') {
        await api('/v1/account/language', options);
        location.replace('/account?changed=language');
      } else {
        const result = await api<{ redirect: string }>('/v1/account/delete', options);
        location.assign(result.redirect);
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.redirecting)) toast({
        title: t('The request could not be completed.'), description: error instanceof ApiError ? error.description : undefined, tone: 'danger',
      });
    } finally {
      this.pending = null;
      if (emailSent) await this.toggleEmail(false);
    }
  };

  private change = (field: keyof Drafts, value: string) => {
    const saved = field === 'profile' ? this.profile?.display_name : this.profile?.locale;
    this.drafts = { ...this.drafts, [field]: value === (saved ?? '') ? undefined : value };
  };

  private toggleEmail = async (open: boolean) => {
    this.emailOpen = open;
    await this.updateComplete;
    (open ? this.querySelector<HTMLElement>('#new_email') : this.querySelector<HTMLElement>('#im-change-email'))?.focus();
  };

  private fields(): TemplateResult {
    if (this.profile) return profileFields(this.profile, this.pending, this.submit, {
      drafts: this.drafts, change: this.change, emailOpen: this.emailOpen, toggleEmail: this.toggleEmail,
    });
    if (this.loadError) return html`
      <div class="fd-empty" data-tone="danger" role="alert">
        <h2 class="fd-h3">${t('The page did not load')}</h2>
        <p class="fd-empty-text">${this.loadError}</p>
        <div class="fd-empty-actions"><button class="fd-btn" type="button" @click=${this.load}>${t('Try again')}</button></div>
      </div>`;
    return html`
      <span class="fd-sr-only" role="status">${t('Loading profile')}</span>
      <div class="fd-skeleton fd-skeleton-form" aria-hidden="true">
        <div class="fd-skeleton-form-field"><div class="fd-shimmer fd-skeleton-title" data-size="label"></div><div class="fd-shimmer fd-skeleton-form-control"></div></div>
        <div class="fd-skeleton-form-field"><div class="fd-shimmer fd-skeleton-title" data-size="label"></div><div class="fd-shimmer fd-skeleton-form-control"></div></div>
      </div>`;
  }

  protected override render() {
    return html`
      <main class="fd-page">
        <div class="fd-frame">
          ${pageHead(t('Profile'), t('Your name and email, as the apps you sign in to see them.'))}
          <section class="fd-band fd-stack" data-gap="5" data-grow aria-busy=${this.pending !== null || (!this.profile && !this.loadError)}>
            ${this.fields()}
            ${this.profile ? deleteSection(this.profile.email, this.pending, this.submit) : nothing}
          </section>
        </div>
      </main>`;
  }
}

customElements.define('screen-profile', ScreenProfile);
