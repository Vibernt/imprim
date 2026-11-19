import { html, nothing } from 'lit';
import { t } from '../lib/i18n';
import { icon } from '../lib/icon';
import { href, type ScreenRoute, type View } from '../lib/router';
import { routes } from '../routes';

type NavRoute = ScreenRoute & Required<Pick<ScreenRoute, 'label' | 'icon' | 'area'>>;
const navigation = routes.filter((route): route is NavRoute => 'tag' in route && Boolean(route.label && route.icon && route.area));

const current = (view: View, route: NavRoute) => (
  view.route.path === route.path || (route.path === '/admin/workspaces' && view.route.path.startsWith(route.path + '/'))
) ? 'page' : nothing;

function groups(view: View) {
  const visible = (route: NavRoute) => route.area === 'account' ||
    (view.session.admin !== null && (route.group !== 'Platform' || view.session.admin === 'platform'));
  const adminArea = view.route.area === 'admin';
  return [
    { label: adminArea ? 'Your account' : t('Your account'), routes: navigation.filter(route => route.area === 'account') },
    { label: adminArea ? 'Admin console' : t('Admin console'), routes: navigation.filter(route => route.area === 'admin' && !route.group && visible(route)) },
    ...['Realm', 'Platform'].map(label => ({ label, routes: navigation.filter(route => route.group === label && visible(route)) })),
  ].filter(group => group.routes.length);
}

// Fire reads its document labels once. Switching areas from a localized shell needs its own label dictionary.
export const documentForArea = (view: View, area: ScreenRoute['area']) =>
  view.session.locale !== 'en' && view.route.area !== area;

const labelOf = (view: View, route: NavRoute) => route.label(view.route.area === 'admin');

export const sidebarNav = (view: View) => groups(view).map(group => html`
  <p class="fd-nav-label">${group.label}</p>
  ${group.routes.map(route => html`<a class="fd-nav-item" href=${href(route.path)} ?data-im-document=${documentForArea(view, route.area)} aria-current=${current(view, route)}>
    ${icon(route.icon)}<span class="fd-nav-text">${labelOf(view, route)}</span></a>`)}`);

export const mobileNav = (view: View) => groups(view).map(group => html`
  <div class="fd-mobile-nav-section">
    <p class="fd-mobile-nav-label">${group.label}</p>
    ${group.routes.map(route => html`<a class="fd-mobile-nav-item" href=${href(route.path)} ?data-im-document=${documentForArea(view, route.area)} aria-current=${current(view, route)}>
      <span>${labelOf(view, route)}</span>${icon(route.icon)}</a>`)}
  </div>`);

export const tabbar = (view: View) => html`
  <nav class="fd-tabbar" aria-label=${view.route.area === 'admin' ? 'Menu' : t('Menu')}>
    ${navigation.filter(route => route.area === 'account').map(route => html`<a class="fd-tabbar-item" href=${href(route.path)} ?data-im-document=${documentForArea(view, route.area)} aria-current=${current(view, route)}>
      ${icon(route.icon)}<span class="fd-tabbar-label">${labelOf(view, route)}</span></a>`)}
    <button class="fd-tabbar-item" type="button" data-fd-mobile-nav aria-controls="im-mobile-nav" aria-expanded="false">
      ${icon('ellipsis')}<span class="fd-tabbar-label">${view.route.area === 'admin' ? 'More' : t('More')}</span>
    </button>
  </nav>`;
