import { html, nothing, type TemplateResult } from 'lit';
import type { IconName } from 'fire-design';
import { FireLight } from '../lib/fire-light';
import { t } from '../lib/i18n';
import { icon } from '../lib/icon';
import { href, retry } from '../lib/router';

const page = (title: string, glyph: IconName, description: string, actions: TemplateResult, tone?: string) => html`
  <main class="fd-page">
    <div class="fd-frame">
      <section class="fd-band" aria-label=${title} data-grow>
        <div class="fd-empty" data-size="lg" data-tone=${tone ?? nothing}>
          <span class="fd-empty-icon">${icon(glyph)}</span>
          <h1 class="fd-h1">${title}</h1>
          <p class="fd-empty-text">${description}</p>
          <div class="fd-empty-actions">${actions}</div>
        </div>
      </section>
    </div>
  </main>`;
const home = () => html`<a class="fd-btn" data-variant="primary" href=${href('/account')}>${t('Your account')}</a>`;

class ScreenNotFound extends FireLight {
  protected override render() {
    return page(t('Page not found'), 'search', t('Check the address or return to your account.'), home());
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
