import { html, nothing } from 'lit';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { AccountScreen } from './account-screen';
import { empty, initial, when } from './access-view';

interface App { id: string; name: string; summary: string | null; mark: string | null; href: string; last_signed_in: number | null }

class ScreenApps extends AccountScreen<{ apps: App[] }> {
  protected override read() {
    return api<{ apps: App[] }>('/v1/account/apps');
  }

  protected override render() {
    return this.page(t('Apps'), '', ({ apps }) => html`
      <div class="fd-card-grid">
        ${apps.length ? apps.map(app => html`<a class="fd-card" data-interactive data-im-document href=${app.href}>
          <i class="fd-card-arrow" data-icon="arrow-up-right" aria-hidden="true"></i>
          <div class="fd-card-head">
            <span class="fd-tile" data-size="36" data-tone="accent" aria-hidden="true">${app.mark
              ? html`<img class="im-app-mark" src=${`/assets/brand/${encodeURIComponent(app.mark)}`} alt="">` : initial(app.name)}</span>
            <div class="fd-card-heading"><span class="fd-card-name">${app.name}</span>
              <span class="fd-card-meta">${app.last_signed_in === null ? t('Not signed in yet') : t('Last signed in {date}', { date: when(app.last_signed_in) })}</span></div>
          </div>
          ${app.summary ? html`<p class="fd-card-text"><span class="im-summary">${app.summary}</span></p>` : nothing}
        </a>`) : empty(t('No apps yet'), t('Apps you can sign in to with this account appear here.'))}
      </div>`);
  }
}

customElements.define('screen-apps', ScreenApps);
