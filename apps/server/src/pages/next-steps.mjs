// What a person can do next on a page that stops or ends, so a page that says "sign in" or "start again" links to it:
// the sign-in they were in, when it is still open in this browser; otherwise the app's own sign-in page; and with no
// app in view, the sign-in pages of the realm's apps. An app has a sign-in page here only when an administrator set its
// initiate_login_uri (the same URL invitation and approval emails use); Imprim never guesses one.
import { t } from '../i18n/index.mjs';
import { realmId } from '../realms/realm.mjs';
import { escapeHtml, linkButton } from './ui.mjs';
// More apps than this and the page lists none: it is no longer a short choice.
export const MAX_LISTED_APPS = 5;
const appName = client => {
    try { return JSON.parse(client.branding || '{}').name || client.id; }
    catch { return client.id; }
};
// [{ name, href }] for one app (by id) or, without one, for the realm's apps, by name.
export async function appSignIns(env, appId = env.SIGN_IN?.app) {
    if (!env.DB || !env.REALM) return [];
    const { results } = appId
        ? await env.DB.prepare('SELECT id, branding, initiate_login_uri FROM clients WHERE id=? AND realm_id=? AND initiate_login_uri IS NOT NULL').bind(appId, realmId(env)).all()
        : await env.DB.prepare('SELECT id, branding, initiate_login_uri FROM clients WHERE realm_id=? AND initiate_login_uri IS NOT NULL LIMIT ?').bind(realmId(env), MAX_LISTED_APPS + 1).all();
    if (results.length > MAX_LISTED_APPS) return [];
    return results.map(client => ({ name: appName(client), href: client.initiate_login_uri })).sort((a, b) => a.name.localeCompare(b.name));
}
// The signed-in-again address of a sign-in request still open in this browser.
export const signInAgainHref = id => `/login?request_id=${encodeURIComponent(id)}`;
// Buttons (markup) for the next step. retry: { label, href } when the page that stopped has its own way to try again.
export async function nextSteps(env, { retry } = {}) {
    if (retry) return [linkButton(t(env, retry.label), retry.href, { variant: 'primary', size: 'lg', block: true })];
    if (env.SIGN_IN?.id) return [linkButton(t(env, 'Sign in again'), signInAgainHref(env.SIGN_IN.id), { variant: 'primary', size: 'lg', block: true })];
    const apps = await appSignIns(env);
    return apps.map(app => linkButton(t(env, 'Sign in to {name}', { name: app.name }), app.href, { variant: apps.length === 1 ? 'primary' : 'outline', size: 'lg', block: true }));
}
export const stepsBlock = steps => steps.length ? `<div class="fd-stack" data-gap="2-5">${steps.join('')}</div>` : '';
// A short line of links to the realm's apps, for the administrators' sign-in page: someone who meant to sign in to an
// app (an invitation email without the app's address leads here) sees where to start.
export async function appLinksNote(env) {
    const apps = await appSignIns(env);
    if (!apps.length) return '';
    const links = apps.map(app => `<a class="fd-link" href="${escapeHtml(app.href)}">${escapeHtml(app.name)}</a>`).join('<span aria-hidden="true"> · </span>');
    return `<p class="fd-screen-note"><span>${escapeHtml(t(env, 'Signing in to an app? Start from the app:'))} ${links}</span></p>`;
}
