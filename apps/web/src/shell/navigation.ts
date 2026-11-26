import { html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { t } from '../lib/i18n';
import { icon } from '../lib/icon';
import { href, type ScreenRoute, type View } from '../lib/router';
import { routes } from '../routes';

type NavRoute = ScreenRoute & Required<Pick<ScreenRoute, 'label' | 'icon' | 'area'>>;
const navigation = routes.filter((route): route is NavRoute => 'tag' in route && Boolean(route.label && route.icon && route.area));

const current = (view: View, route: NavRoute) =>
  view.route.path === route.path || (route.area === 'admin' && view.route.path.startsWith(route.path + '/')) ? 'page' : nothing;

const phoneRoutes = ['/admin/clients', '/admin/users', '/admin/workspaces', '/admin/signups'];
const onPhoneBar = (route: NavRoute) => phoneRoutes.includes(route.path);

// The admin pages show only when this session passes every admin console rule (admin_ready from /v1/me). An
// administrator who has not, such as one without a fresh second factor, gets one way in instead: a full page load of
// the console, which the server turns into the sign-in, second-factor or enrolment step it needs.
const gated = (view: View) => view.session.admin !== null && !view.session.admin_ready;

function groups(view: View) {
  const visible = (route: NavRoute) => route.area === 'account' ||
    (view.session.admin_ready && (route.group !== 'Platform' || view.session.admin === 'platform'));
  const adminArea = view.route.area === 'admin';
  return [
    { label: adminArea ? 'Your account' : t('Your account'), routes: navigation.filter(route => route.area === 'account') },
    { label: adminArea ? 'Admin console' : t('Admin console'), routes: navigation.filter(route => route.area === 'admin' && !route.group && visible(route)) },
    ...['Realm', 'Platform'].map(label => ({ label, routes: navigation.filter(route => route.group === label && visible(route)) })),
  ].filter(group => group.routes.length);
}

const ADMIN_HOME = '/admin/clients';

// Fire reads its document labels once. Switching areas from a localized shell needs its own label dictionary.
export const documentForArea = (view: View, area: ScreenRoute['area']) =>
  view.session.locale !== 'en' && view.route.area !== area;

const labelOf = (view: View, route: NavRoute) => route.label(view.route.area === 'admin');

const countBadge = (route: NavRoute, pending: number | undefined) => route.path === '/admin/signups' && pending !== undefined
  ? html`<span class="fd-nav-badge" aria-label=${pending + ' pending'}>${pending}</span>` : nothing;

export const sidebarNav = (view: View, pending?: number) => html`${groups(view).map(group => html`
  <p class="fd-nav-label">${group.label}</p>
  ${group.routes.map(route => html`<a class="fd-nav-item" href=${href(route.path)} ?data-im-document=${documentForArea(view, route.area)} aria-current=${current(view, route)}>
    ${icon(route.icon)}<span class="fd-nav-text">${labelOf(view, route)}</span>${countBadge(route, pending)}</a>`)}`)}
  ${gated(view) ? html`<p class="fd-nav-label">${t('Admin console')}</p>
  <a class="fd-nav-item" href=${href(ADMIN_HOME)} data-im-document>${icon('lock')}<span class="fd-nav-text">${t('Open admin console')}</span></a>` : nothing}`;

export const mobileNav = (view: View) => html`${groups(view).map(group => html`
  <div class="fd-mobile-nav-section">
    <p class="fd-mobile-nav-label">${group.label}</p>
    ${group.routes.map(route => html`<a class="fd-mobile-nav-item ${classMap({ 'im-phone-tab-destination': view.route.area === 'admin' && onPhoneBar(route) })}"
      href=${href(route.path)} ?data-im-document=${documentForArea(view, route.area)} aria-current=${current(view, route)}>
      <span>${labelOf(view, route)}</span>${icon(route.icon)}</a>`)}
  </div>`)}
  ${gated(view) ? html`<div class="fd-mobile-nav-section">
    <p class="fd-mobile-nav-label">${t('Admin console')}</p>
    <a class="fd-mobile-nav-item" href=${href(ADMIN_HOME)} data-im-document><span>${t('Open admin console')}</span>${icon('lock')}</a>
  </div>` : nothing}`;

export const tabbar = (view: View) => {
  const admin = view.route.area === 'admin';
  const visible = groups(view).flatMap(group => group.routes);
  const tabs = admin ? phoneRoutes.flatMap(path => visible.filter(route => route.path === path))
    : visible.filter(route => route.area === 'account');
  return html`<nav class="fd-tabbar" aria-label=${admin ? 'Admin console' : t('Your account')}>
    ${tabs.map(route => html`<a class="fd-tabbar-item" href=${href(route.path)} ?data-im-document=${documentForArea(view, route.area)} aria-current=${current(view, route)}>
      ${icon(route.icon)}<span class="fd-tabbar-label">${admin && route.path === '/admin/signups' ? 'Sign-ups' : labelOf(view, route)}</span></a>`)}
    ${admin ? html`<button class="fd-tabbar-item" type="button" data-fd-mobile-nav aria-controls="im-mobile-nav"
      aria-expanded="false" aria-current=${tabs.some(route => current(view, route) === 'page') ? nothing : 'page'}>
      ${icon('ellipsis')}<span class="fd-tabbar-label">More</span></button>` : nothing}
  </nav>`;
};
