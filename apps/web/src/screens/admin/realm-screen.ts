import { html, nothing, type PropertyDeclarations, type PropertyValues, type TemplateResult } from 'lit';
import { ApiError, api } from '../../lib/api';
import { FireLight } from '../../lib/fire-light';
import type { View } from '../../lib/router';
import { pageHead } from '../page-layout';
import { loading, type LoadingPreset } from '../loading';

export abstract class AdminRealmScreen<T> extends FireLight {
  static override properties: PropertyDeclarations = {
    view: { attribute: false }, data: { state: true }, loadError: { state: true }, pending: { state: true },
  };
  declare view: View;
  declare protected data: T | undefined;
  declare private loadError: string | undefined;
  declare protected pending: boolean;
  private generation = 0;
  private address = '';
  protected abstract readonly skeleton: readonly LoadingPreset[];
  protected abstract heading: string;
  protected get description() { return ''; }

  protected abstract endpoint(): string;
  protected abstract content(data: T): unknown;
  protected back() { return nothing as typeof nothing | TemplateResult; }
  protected actions() { return nothing as typeof nothing | TemplateResult; }
  protected meta() { return nothing as typeof nothing | TemplateResult; }
  protected contentPadding(): 'none' | typeof nothing { return nothing; }

  protected override willUpdate(changed: PropertyValues) {
    if (!changed.has('view')) return;
    const address = this.view.path + '?' + this.view.query;
    if (this.address === address) return;
    this.address = address;
    void this.load();
  }

  protected load = async (clear = true) => {
    const generation = ++this.generation;
    if (clear) this.data = undefined;
    this.loadError = undefined;
    try {
      const result = await api<T>(this.endpoint());
      if (generation === this.generation && this.isConnected) this.data = result;
    } catch (error) {
      if (generation === this.generation && !(error instanceof ApiError && error.redirecting)) {
        this.loadError = error instanceof Error ? error.message : 'The request could not be completed.';
        this.data = undefined;
      }
    }
  };

  protected override updated() {
    super.updated();
    if (this.isConnected) document.title = `${this.heading} · ${this.view.session.realm.display_name}`;
  }

  protected override render() {
    return html`<main class="fd-page" id="main" tabindex="-1"><div class="fd-frame">
      ${pageHead(this.heading, this.description, this.back(), this.actions(), this.meta())}
      <section class="fd-band" data-grow data-pad=${this.contentPadding()} aria-busy=${Boolean(this.data && this.pending)}>
        ${this.data ? this.content(this.data) : this.loadError ? html`
          <div class="fd-empty" data-tone="danger" role="alert">
            <h2 class="fd-empty-title">The page did not load</h2><p class="fd-empty-text">${this.loadError}</p>
            <div class="fd-empty-actions"><button class="fd-btn" type="button" @click=${() => this.load()}>Try again</button></div>
          </div>` : loading(this.skeleton, { status: 'Loading', late: 'Still loading. This is taking longer than usual.' })}
      </section>
    </div></main>`;
  }
}
