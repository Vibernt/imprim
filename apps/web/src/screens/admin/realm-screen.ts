import { html, nothing, type PropertyDeclarations, type PropertyValues, type TemplateResult } from 'lit';
import { ApiError, api } from '../../lib/api';
import { FireLight } from '../../lib/fire-light';
import type { View } from '../../lib/router';
import { pageHead } from '../page-layout';

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
  protected abstract heading: string;
  protected get description() { return ''; }

  protected abstract endpoint(): string;
  protected abstract content(data: T): unknown;
  protected back() { return nothing as typeof nothing | TemplateResult; }
  protected actions() { return nothing as typeof nothing | TemplateResult; }

  protected override willUpdate(changed: PropertyValues) {
    if (!changed.has('view')) return;
    const address = this.view.path + '?' + this.view.query;
    if (this.address === address) return;
    this.address = address;
    void this.load();
  }

  protected load = async () => {
    const generation = ++this.generation;
    this.data = undefined;
    this.loadError = undefined;
    try {
      const result = await api<T>(this.endpoint());
      if (generation === this.generation && this.isConnected) this.data = result;
    } catch (error) {
      if (generation === this.generation && !(error instanceof ApiError && error.redirecting)) {
        this.loadError = error instanceof Error ? error.message : 'The request could not be completed.';
      }
    }
  };

  protected override updated() {
    super.updated();
    if (this.isConnected) document.title = `${this.heading} · ${this.view.session.realm.display_name}`;
  }

  protected override render() {
    return html`<main class="fd-page"><div class="fd-frame">
      ${pageHead(this.heading, this.description, this.back(), this.actions())}
      <section class="fd-band" data-grow aria-busy=${Boolean(this.pending || (!this.data && !this.loadError))}>
        ${this.data ? this.content(this.data) : this.loadError ? html`
          <div class="fd-empty" data-tone="danger" role="alert">
            <h2 class="fd-empty-title">The page did not load</h2><p class="fd-empty-text">${this.loadError}</p>
            <div class="fd-empty-actions"><button class="fd-btn" type="button" @click=${this.load}>Try again</button></div>
          </div>` : html`<div class="fd-skeleton-list" data-rows="5" role="status" aria-label="Loading"></div>`}
      </section>
    </div></main>`;
  }
}
