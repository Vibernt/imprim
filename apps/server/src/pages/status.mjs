import { cookie, cookies, getSession } from '../auth/session.mjs';
import { sha256 } from '../lib/crypto.mjs';
import { invariant } from '../lib/errors.mjs';
import { redirect } from '../lib/http.mjs';
import { brandCopy, t } from '../i18n/index.mjs';
import { isAdmin } from '../services/admission.mjs';
import { appList, listedApps, yourApps } from './app-list.mjs';
import { errorPage, only, page } from './layout.mjs';
import { escapeHtml, linkButton, result } from './ui.mjs';

const SKIP_COOKIE = '__Host-vi_app_skip';
async function skipToApp(request, apps, guard) {
    if (apps.length !== 1) return null;
    const key = await sha256(apps[0].id), now = Date.now();
    if (guard) {
        const [previous, when] = (cookies(request)[SKIP_COOKIE] || '').split('.');
        const age = now - Number(when);
        if (previous === key && age >= 0 && age < 60000) return null;
    }
    return redirect(apps[0].href, [cookie(SKIP_COOKIE, `${key}.${now}`, 60)]);
}
export async function signedIn(request, env) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    const apps = await yourApps(env, session.user_id);
    // Administrators sign in here on their way to the console (/login), so they always get the page and its link.
    const skip = await isAdmin(env, session.email) ? null : await skipToApp(request, apps, false);
    return skip ?? page(t(env, 'Signed in'),
        result('circle-check', 'success', t(env, 'You’re signed in')) + appList(env, apps, true) +
        `<div class="fd-stack" data-gap="2-5">${only('admin', linkButton(t(env, 'Open the admin console'), '/admin', { variant: 'primary', size: 'lg', block: true }))}${linkButton(t(env, 'Your account'), '/account', { size: 'lg', block: true })}</div>`);
}
export async function signedOut(env) {
    const copy = brandCopy(env, env.REALM.branding || {}, 'signed_out') || t(env, 'Some apps keep you signed in until you sign out there.');
    return page(t(env, 'Signed out'), result('log-out', 'neutral', t(env, 'You’re signed out'), copy, { muted: false }) +
        appList(env, await listedApps(env)));
}
export async function signInError(request, env, message, status, { expired, retry } = {}) {
    const session = !env.SIGN_IN?.app || expired ? await getSession(request, env) : null;
    const personalApps = expired && session ? await yourApps(env, session.user_id) : undefined;
    return (personalApps && await skipToApp(request, personalApps, true)) ||
        errorPage(env, message, status, { expired, retry, session, personalApps });
}
