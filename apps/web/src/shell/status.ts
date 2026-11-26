import { html, nothing, type TemplateResult } from 'lit';
import type { IconName } from 'fire-design';
import { FireLight } from '../lib/fire-light';
import { t } from '../lib/i18n';
import { icon } from '../lib/icon';
import { href, retry, type View } from '../lib/router';
import { pageHead } from '../screens/page-layout';

const page = (title: string, glyph: IconName, description: string, actions: TemplateResult, tone?: string) => html`
  <main class="fd-page">
    <div class="fd-frame">
      ${pageHead(title)}
      <section class="fd-band" aria-label=${title} data-grow>
        <div class="fd-empty" data-size="lg" data-tone=${tone ?? nothing}>
          <span class="fd-empty-icon">${icon(glyph)}</span>
          <p class="fd-empty-text">${description}</p>
          <div class="fd-empty-actions">${actions}</div>
        </div>
      </section>
    </div>
  </main>`;
const home = () => html`<a class="fd-btn" data-variant="primary" href=${href('/account')}>${t('Your account')}</a>`;

class ScreenNotFound extends FireLight {
  declare view: View;
  protected override render() {
    const admin = this.view.route.area === 'admin';
    const title = admin ? 'Page not found' : t('Page not found');
    return html`<main class="fd-page"><div class="fd-frame">
      <section class="fd-band" data-grow aria-label=${title}>
        <div class="fd-empty" data-size="lg">
          <span class="fd-empty-icon">${icon('search')}</span>
          <h1 class="fd-h1">${title}</h1>
          <p class="fd-empty-text">${admin ? 'Check the address or return to your account.' : t('Check the address or return to your account.')}</p>
          <div class="fd-empty-actions"><a class="fd-btn" data-variant="primary" href=${href('/account')}
            ?data-im-document=${admin && this.view.session.locale !== 'en'}>${admin ? 'Profile' : t('Profile')}</a></div>
        </div>
      </section>
    </div></main>`;
  }
}

class ScreenNoAccess extends FireLight {
  protected override render() {
    return page(t('No access'), 'shield-alert', t('Your role does not give you access to this page.'), home(), 'warning');
  }
}

class ScreenLoadError extends FireLight {
  static override properties = { startup: { type: Boolean } };
  declare startup: boolean;

  protected override render() {
    return page(t('The page did not load'), 'circle-alert', t('Try opening the page again.'), html`
      <button class="fd-btn" type="button" data-variant="primary"
        @click=${() => this.startup ? location.reload() : void retry()}>${t('Try again')}</button>`, 'danger');
  }
}

customElements.define('screen-not-found', ScreenNotFound);
customElements.define('screen-no-access', ScreenNoAccess);
customElements.define('screen-load-error', ScreenLoadError);
