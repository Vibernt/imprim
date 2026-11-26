import { html, nothing, type PropertyDeclarations, type PropertyValues, type TemplateResult } from 'lit';
import { overlays } from 'fire-design';
import { ApiError, api } from '../../lib/api';
import { FireLight } from '../../lib/fire-light';
import { icon } from '../../lib/icon';
import { href, type View } from '../../lib/router';
import { pageHead } from '../page-layout';

const { toast } = overlays;
const redirecting = (error: unknown) => error instanceof ApiError && error.redirecting;
const describe = (error: unknown) => error instanceof ApiError ? error.description : 'The request could not be completed.';

export abstract class AdminScreen<T> extends FireLight {
  static override properties: PropertyDeclarations = {
    view: { attribute: false }, data: { state: true }, failure: { state: true }, pending: { state: true }, saveError: { state: true },
  };
  declare view: View;
  declare protected data: T | undefined;
  declare protected failure: string | undefined;
  declare protected pending: boolean;
  // A screen with a sticky save bar sets inlineSaveErrors and renders saveErrorNotice() beside it: a notice in the
  // corner would cover the bar's Save button, the one control the person needs next.
  declare protected saveError: string | undefined;
  protected inlineSaveErrors = false;
  private read = 0;
  private path?: string;

  protected abstract requestPath(view: View): string;

  protected override willUpdate(changed: PropertyValues) {
    if (!changed.has('view') || !this.view) return;
    const path = this.requestPath(this.view);
    if (this.path === path) return;
    this.path = path;
    this.data = undefined;
    this.pending = false;
    void this.reload();
  }

  protected reload = async () => {
    if (!this.path) return;
    const read = ++this.read;
    this.failure = undefined;
    try {
      const data = await api<T>(this.path);
      if (this.isConnected && read === this.read) this.data = data;
    } catch (error) {
      if (this.isConnected && read === this.read && !redirecting(error)) {
        this.failure = describe(error);
        this.data = undefined;
      }
    }
  };

  protected async write<U extends object>(
    path: string, body: object, success: string | ((result: U) => string), apply: (result: U) => void | Promise<void>,
  ) {
    if (this.pending) return;
    const current = this.path;
    const read = this.read;
    this.pending = true;
    try {
      const result = await api<U>(path, { method: 'POST', body });
      if (!this.isConnected || read !== this.read) return;
      await apply(result);
      const delivery = (result as { delivery?: { message?: string } }).delivery;
      this.saveError = undefined;
      toast({ title: typeof success === 'string' ? success : success(result), description: delivery?.message, tone: 'success' });
    } catch (error) {
      if (this.isConnected && read === this.read && !redirecting(error)) {
        if (this.inlineSaveErrors) this.saveError = describe(error);
        else toast({ title: 'Change could not be saved', description: describe(error), tone: 'danger' });
      }
    } finally {
      if (current === this.path) this.pending = false;
    }
  }

  protected saveErrorNotice() {
    return this.saveError ? html`
      <div class="fd-callout" data-tone="danger" role="alert">${icon('circle-alert')}<div class="fd-callout-content">
        <p class="fd-callout-title">Change could not be saved</p><p class="fd-callout-body">${this.saveError}</p></div></div>` : nothing;
  }

  protected content(render: (data: T) => TemplateResult) {
    if (this.data) return render(this.data);
    if (this.failure) return html`
      <div class="fd-empty" data-tone="danger" role="alert">
        <h2 class="fd-h3">The page did not load</h2>
        <p class="fd-empty-text">${this.failure}</p>
        <div class="fd-empty-actions"><button class="fd-btn" type="button" @click=${this.reload}>Try again</button></div>
      </div>`;
    return html`
      <div role="status"><span class="fd-sr-only">Loading</span><span class="fd-spinner" aria-hidden="true"></span></div>`;
  }
}

export function corePage(title: string, description: string, content: TemplateResult, options: {
  back?: { path: string; label: string }; actions?: TemplateResult; busy?: boolean;
} = {}) {
  return html`
    <main class="fd-page">
      <div class="fd-frame">
        ${pageHead(title, description, options.back ? html`
          <a class="fd-back" href=${href(options.back.path)}>${icon('arrow-left')}<span>${options.back.label}</span></a>` : nothing, options.actions)}
        <section class="fd-band" data-grow aria-busy=${options.busy ?? false}>${content}</section>
      </div>
    </main>`;
}
