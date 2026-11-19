import { html, type PropertyDeclarations } from 'lit';
import { overlays } from 'fire-design';
import { ApiError, api } from '../../lib/api';
import { FireLight } from '../../lib/fire-light';
import { t } from '../../lib/i18n';

export const post = <T = object>(path: string, body: object = {}) => api<T>(`/v1/account/${path}`, { method: 'POST', body });
export const success = (title: string, description?: string) => overlays.toast({ title, description, tone: 'success' });
const describe = (error: unknown) => error instanceof ApiError ? error.description : t('The request could not be completed.');

export abstract class AccountScreen<T> extends FireLight {
  static override properties: PropertyDeclarations = { data: { state: true }, loadError: { state: true }, pending: { state: true } };
  declare protected data: T | undefined;
  declare protected loadError: string | undefined;
  protected pending = false;
  private readVersion = 0;

  protected abstract read(): Promise<T>;

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  protected load = async (clear = true) => {
    const version = ++this.readVersion;
    this.loadError = undefined;
    if (clear) this.data = undefined;
    try {
      const data = await this.read();
      if (this.isConnected && version === this.readVersion) this.data = data;
    } catch (error) {
      if (this.isConnected && version === this.readVersion && !(error instanceof ApiError && error.redirecting)) {
        this.loadError = describe(error);
      }
    }
  };

  protected async mutate(work: () => Promise<void>) {
    if (this.pending) return;
    this.pending = true;
    try {
      await work();
    } catch (error) {
      if (this.isConnected && !(error instanceof ApiError && error.redirecting)) {
        overlays.toast({ title: t('The request could not be completed.'), description: describe(error), tone: 'danger' });
      }
    } finally {
      this.pending = false;
    }
  }

  protected page(title: string, description: string, content: (data: T) => unknown) {
    return html`
      <main class="fd-page"><div class="fd-frame">
        <section class="fd-band fd-page-hero"><h1 class="fd-display" tabindex="-1">${title}</h1><p class="fd-page-hero-desc">${description}</p></section>
        <section class="fd-band fd-stack" data-gap="5" aria-busy=${Boolean(this.pending || (!this.data && !this.loadError))}>
          ${this.loadError ? html`
            <div class="fd-empty" data-tone="danger" role="alert">
              <h2 class="fd-h3">${t('The page did not load')}</h2><p class="fd-empty-text">${this.loadError}</p>
              <div class="fd-empty-actions"><button class="fd-btn" type="button" @click=${() => this.load()}>${t('Try again')}</button></div>
            </div>` : this.data ? content(this.data) : html`
            <span class="fd-sr-only" role="status">${t('Loading account details')}</span>
            <div class="fd-skeleton fd-skeleton-form" aria-hidden="true"><div class="fd-skeleton-form-field">
              <div class="fd-shimmer fd-skeleton-title" data-size="label"></div><div class="fd-shimmer fd-skeleton-form-control"></div>
            </div></div>`}
        </section>
      </div></main>`;
  }
}
