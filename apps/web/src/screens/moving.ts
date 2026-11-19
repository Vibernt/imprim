import { html } from 'lit';
import { FireLight } from '../lib/fire-light';
import { t } from '../lib/i18n';
import { icon } from '../lib/icon';
import type { View } from '../lib/router';
import { pageHead } from './page-layout';

class ScreenMoving extends FireLight {
  static override properties = { view: { attribute: false } };
  declare view: View;

  protected override render() {
    const { route, query } = this.view;
    const admin = route.area === 'admin';
    return html`
      <main class="fd-page">
        <div class="fd-frame">
          ${pageHead(route.label?.() ?? '')}
          <section class="fd-band" data-grow>
            <div class="fd-empty" data-size="lg">
              <span class="fd-empty-icon">${icon('arrow-right')}</span>
              <p class="fd-empty-text">${admin ? 'This page is moving. You can still use it at its current address.' : t('This page is moving. You can still use it at its current address.')}</p>
              <div class="fd-empty-actions">
                <a class="fd-btn" data-variant="primary" data-im-document href=${route.path + (query.size ? `?${query}` : '')}>${admin ? 'Open current page' : t('Open current page')}</a>
              </div>
            </div>
          </section>
        </div>
      </main>`;
  }
}
customElements.define('screen-moving', ScreenMoving);
