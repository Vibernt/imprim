import { html, nothing, type LitElement } from 'lit';
import { overlays } from 'fire-design';
import { api, ApiError } from '../lib/api';
import { FireLight } from '../lib/fire-light';
import { t } from '../lib/i18n';
import { icon } from '../lib/icon';
import { href, type Outlet, type View } from '../lib/router';
import { documentForArea, mobileNav, sidebarNav, tabbar } from './navigation';
import './status';

export class AppShell extends FireLight implements Outlet {
  static override properties = { view: { state: true }, startupFailed: { state: true }, signupPending: { state: true } };
  declare view: View | undefined;
  declare startupFailed: boolean;
  private screen?: HTMLElement;
  declare private signupPending: number | undefined;
  private signupRead = 0;

  private refreshSignups = async () => {
    const read = ++this.signupRead;
    try {
      const { pending } = await api<{ pending: number }>('/admin/api/signups/summary');
      if (read === this.signupRead) this.signupPending = pending;
    } catch (error) {
      if (read !== this.signupRead || (error instanceof ApiError && error.redirecting)) return;
      this.signupPending = undefined;
      overlays.toast({ title: 'Pending sign-up count unavailable', tone: 'danger' });
    }
  };

  async show(view: View): Promise<{ screen: HTMLElement; changed: boolean }> {
    const tag = view.error ? 'screen-load-error' : view.route.tag;
    const changed = this.screen?.localName !== tag || this.view?.route !== view.route;
    const screen = changed ? document.createElement(tag) : this.screen!;
    Object.assign(screen, { params: view.params, query: view.query, view });
    const previous = this.view?.route.area;
    this.screen = screen;
    this.view = view;
    if (view.route.area === 'admin' && previous !== 'admin') void this.refreshSignups();
    if (view.route.area !== 'admin' && previous === 'admin') {
      this.signupRead++;
      this.signupPending = undefined;
    }
    await this.updateComplete;
    await (screen as LitElement).updateComplete;
    return { screen, changed };
  }

  announce(text: string): void {
    const region = this.querySelector('#im-route-status');
    if (!region) return;
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = text; });
  }

  protected override render() {
    const view = this.view;
    if (!view) return this.startupFailed ? html`<screen-load-error startup></screen-load-error>` : nothing;
    const { email, initials, realm } = view.session;
    const admin = view.route.area === 'admin';
    const signOut = admin ? 'Sign out' : t('Sign out');
    const navigation = admin ? 'Admin console' : t('Your account');
    const section = typeof view.route.title === 'function' ? view.route.title(view) : view.route.title;
    return html`
      <div class="fd-app" data-sidebar="expanded" @im-signup-decided=${this.refreshSignups}>
        <aside class="fd-sidebar" aria-label=${navigation}>
          <div class="fd-sidebar-head">
            <a class="fd-brand" href=${href('/account')} ?data-im-document=${documentForArea(view, 'account')}>
              <span class="fd-brand-mark"></span><span class="fd-brand-name">${realm.display_name}</span>
            </a>
            <button class="fd-btn fd-sidebar-toggle" type="button" data-variant="ghost" data-size="lg" data-icon-only
              data-fd-sidebar-toggle aria-label=${admin ? 'Collapse sidebar' : t('Collapse sidebar')}>${icon('panel-left')}</button>
          </div>
          <div class="fd-sidebar-body"><nav class="fd-nav" aria-label=${navigation}>${sidebarNav(view, this.signupPending)}</nav></div>
          <div class="fd-sidebar-foot">
            <a class="fd-account" href=${href('/account')} ?data-im-document=${documentForArea(view, 'account')} aria-label=${admin ? `Your account, ${email}` : t('Your account, {email}', { email })}>
              <span class="fd-account-avatar" aria-hidden="true">${initials}</span><span class="fd-account-email">${email}</span>
            </a>
          </div>
        </aside>
        <div class="fd-main">
          <header class="fd-topbar">
            <span class="fd-topbar-title">${admin ? realm.display_name : view.route.label?.() ?? section}</span>
            <div class="fd-topbar-actions">
              <a class="fd-btn" data-variant="ghost" data-only="desktop" href="/logout">${icon('log-out')}<span>${signOut}</span></a>
              <button class="fd-btn" type="button" data-icon-only data-only="mobile" data-fd-mobile-nav aria-controls="im-mobile-nav"
                aria-expanded="false" aria-label=${admin ? 'Open menu' : t('Open menu')}>${icon('menu')}</button>
            </div>
          </header>
          ${this.screen}
          <p class="fd-sr-only" id="im-route-status" aria-live="polite"></p>
        </div>
        <div class="fd-mobile-nav" id="im-mobile-nav" role="dialog" aria-modal="true" aria-label=${admin ? 'Menu' : t('Menu')} data-state="closed" hidden>
          <a class="fd-mobile-nav-account" href=${href('/account')} ?data-im-document=${documentForArea(view, 'account')}><span>${email}</span><span class="fd-account-avatar" aria-hidden="true">${initials}</span></a>
          ${mobileNav(view)}
          <div class="fd-mobile-nav-section"><a class="fd-mobile-nav-item" href="/logout"><span>${signOut}</span></a></div>
        </div>
        ${tabbar(view)}
      </div>`;
  }
}
customElements.define('app-shell', AppShell);
