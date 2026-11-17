// The app shell for the admin console and the account pages: Fire's sidebar, top bar, page hero and phone menu
// (docs/fire/GUIDE.md section 3), rendered on the server. /imprim/shell.js adds the sidebar collapse, the phone menu
// and the hero texture. Labels and descriptions are text and are escaped here; `body`, `actions` and `back` hrefs come
// from the pages.
import { htmlResponse, escapeHtml as e, icon, only, SIDE_BRAND, MARK, SHELL_FOOTER, VIEWER, INITIALS } from './layout.mjs';
import { t, msg } from '../i18n/index.mjs';
// The account area is translated (its labels are marked with msg()); the admin console stays English.
// Sign-out asks first: /logout shows a confirmation, and only its form ends the session.
const SIGN_OUT = env => `<a class="fd-btn" data-variant="ghost" data-only="desktop" href="/logout">${icon('log-out')}<span>${e(t(env, 'Sign out'))}</span></a>`;
const ADMIN = { id: 'admin', label: 'Admin console', home: '/admin', sections: [
    { items: [['clients', 'Clients', 'blocks', '/admin/clients'], ['services', 'Services', 'server', '/admin/services'], ['users', 'Users', 'users', '/admin/users'], ['workspaces', 'Workspaces', 'workflow', '/admin/workspaces']] },
    { label: 'Realm', items: [['branding', 'Branding', 'palette', '/admin/branding'], ['audit', 'Audit log', 'scroll-text', '/admin/audit'], ['settings', 'Settings', 'settings', '/admin/settings']] },
    { label: 'Platform', only: 'platform', items: [['keys', 'Signing keys', 'key-round', '/admin/keys'], ['realms', 'Realms', 'globe', '/admin/realms']] }],
    actions: env => `<a class="fd-btn" data-variant="ghost" data-only="desktop" href="/login">${icon('refresh-cw')}<span>Sign in again</span></a><a class="fd-btn" data-only="desktop" href="/account">${icon('user')}<span>Your account</span></a>${SIGN_OUT(env)}`,
    phone: [['Your account', '/account'], ['Sign in again', '/login'], ['Sign out', '/logout']] };
const ACCOUNT = { id: 'account', label: msg('Your account'), home: '/account', sections: [
    { items: [['profile', msg('Profile'), 'user', '/account'], ['security', msg('Security'), 'shield-check', '/account/security'], ['sessions', msg('Sessions and apps'), 'monitor', '/account/sessions'], ['agents', msg('Agents'), 'bot', '/account/agents']] },
    { label: msg('Administration'), only: 'admin', items: [['admin', msg('Admin console'), 'settings', '/admin']] }],
    actions: env => only('admin', `<a class="fd-btn" data-only="desktop" href="/admin">${icon('settings')}<span>${e(t(env, 'Admin console'))}</span></a>`) + SIGN_OUT(env), phone: [[msg('Sign out'), '/logout']] };
const AREAS = { admin: ADMIN, account: ACCOUNT };
const current = on => on ? ' aria-current="page"' : '';
const gated = (section, html) => section.only ? only(section.only, html) : html;
function sidebar(env, area, active) {
    const nav = area.sections.map(section => gated(section, (section.label ? `<p class="fd-nav-label">${e(t(env, section.label))}</p>` : '') +
        section.items.map(([id, label, glyph, href]) => `<a class="fd-nav-item" href="${href}"${current(id === active)}>${icon(glyph)}<span class="fd-nav-text">${e(t(env, label))}</span></a>`).join(''))).join('');
    return `<aside class="fd-sidebar" aria-label="${e(t(env, area.label))}"><div class="fd-sidebar-head"><a class="fd-brand" href="${area.home}">${SIDE_BRAND}</a>
<button class="fd-btn fd-sidebar-toggle" type="button" data-variant="ghost" data-size="lg" data-icon-only data-fd-sidebar-toggle aria-label="${e(t(env, 'Collapse sidebar'))}">${icon('panel-left')}</button></div>
<div class="fd-sidebar-body"><nav class="fd-nav" aria-label="${e(t(env, area.label))}">${nav}</nav></div>
<div class="fd-sidebar-foot"><a class="fd-account" href="/account" aria-label="${e(t(env, 'Your account, {email}')).replace('{email}', VIEWER)}"><span class="fd-account-avatar" aria-hidden="true">${INITIALS}</span><span class="fd-account-email">${VIEWER}</span></a></div></aside>`;
}
function phoneMenu(env, area, active) {
    const sections = area.sections.map(section => gated(section, `<div class="fd-mobile-nav-section">${section.label ? `<p class="fd-mobile-nav-label">${e(t(env, section.label))}</p>` : ''}${
        section.items.map(([id, label, glyph, href]) => `<a class="fd-mobile-nav-item" href="${href}"${current(id === active)}><span>${e(t(env, label))}</span>${icon(glyph)}</a>`).join('')}</div>`)).join('');
    const extra = area.phone.length ? `<div class="fd-mobile-nav-section">${area.phone.map(([label, href]) => `<a class="fd-mobile-nav-item" href="${href}"><span>${e(t(env, label))}</span></a>`).join('')}</div>` : '';
    return `<div class="fd-mobile-nav" id="shell-menu" role="dialog" aria-modal="true" aria-label="${e(t(env, 'Menu'))}" data-state="closed" hidden>
<a class="fd-mobile-nav-account" href="/account"><span>${VIEWER}</span><span class="fd-account-avatar" aria-hidden="true">${INITIALS}</span></a>${sections}${extra}</div>`;
}
// One band of the page, its parts stacked. A string is a band with the usual padding; { html, pad, label } sets them.
const band = (part, last) => {
    const { html, pad, label } = typeof part === 'string' ? { html: part } : part;
    return `<section class="fd-band"${pad ? ` data-pad="${pad}"` : ''}${last ? ' data-grow' : ''}${label ? ` aria-label="${e(label)}"` : ''}><div class="fd-stack" data-gap="6">${html}</div></section>`;
};
// area: "admin" or "account". active: the nav item. description, eyebrow: text. back: [label, href]. actions: safe
// markup for the hero. art: the hero's texture. body: one band's markup, or a list of bands.
// env: the request's, for the language (the admin console's is always English).
export function shellPage(title, body, { env = null, area, active = '', description = '', back = null, actions = '', art = 'terrain', modules = [], ...options } = {}) {
    const a = AREAS[area], bands = [body].flat().filter(Boolean);
    const hero = `<section class="fd-band fd-page-hero fd-rise"><div class="fd-page-hero-art" aria-hidden="true"><div class="fd-ascii" data-fd-ascii="${e(art)}"></div></div>
${back ? `<a class="fd-back" href="${e(back[1])}">${icon('arrow-left')}<span>${e(back[0])}</span></a>` : ''}<h1 class="fd-display">${e(title)}</h1>
${description ? `<p class="fd-page-hero-desc">${e(description)}</p>` : ''}${actions ? `<div class="fd-page-hero-actions">${actions}</div>` : ''}</section>`;
    return htmlResponse(title, `<div class="fd-app" data-sidebar="expanded">${sidebar(env, a, active)}
<div class="fd-main"><header class="fd-topbar"><a class="fd-topbar-brand" data-only="mobile" href="${a.home}" aria-label="${e(t(env, a.label))}"><span class="fd-brand-mark">${MARK}</span></a><span class="fd-topbar-title">${e(t(env, a.label))}</span>
<div class="fd-topbar-actions">${a.actions(env)}<button class="fd-btn" type="button" data-icon-only data-only="mobile" data-fd-mobile-nav aria-controls="shell-menu" aria-expanded="false" aria-label="${e(t(env, 'Open menu'))}">${icon('menu')}</button></div></header>
<main class="fd-page"><div class="fd-frame">${hero}${bands.map((part, i) => band(part, i === bands.length - 1)).join('')}${SHELL_FOOTER}</div></main></div>
${phoneMenu(env, a, active)}</div>`, { ...options, modules: ['/imprim/shell.js', ...modules] });
}
// An account page: Profile, Security, Sessions and apps, or Agents.
export const accountPage = (title, body, options = {}) => shellPage(title, body, { area: 'account', art: 'waves', ...options });
