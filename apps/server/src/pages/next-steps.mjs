import { t } from '../i18n/index.mjs';
import { escapeHtml, linkButton } from './ui.mjs';
import { appList, appSignIn, listedApps, yourApps } from './app-list.mjs';
export { MAX_LISTED_APPS } from './app-list.mjs';

export const signInAgainHref = id => `/login?request_id=${encodeURIComponent(id)}`;

export async function nextSteps(env, { retry, session, personalApps } = {}) {
    const primary = (label, href) => linkButton(label, href, { variant: 'primary', size: 'lg', block: true });
    if (retry) return primary(t(env, retry.label), retry.href);
    if (env.SIGN_IN?.id) return primary(t(env, 'Sign in again'), signInAgainHref(env.SIGN_IN.id));
    if (env.SIGN_IN?.app) {
        const app = await appSignIn(env, env.SIGN_IN.app);
        return app ? primary(t(env, 'Sign in to {name}', { name: app.name }), app.href) : '';
    }
    return session ? appList(env, personalApps ?? await yourApps(env, session.user_id), true)
        : appList(env, await listedApps(env));
}

export async function appLinksNote(env) {
    const apps = await listedApps(env);
    if (!apps.length) return '';
    const links = apps.map(app => `<a class="fd-link" href="${escapeHtml(app.href)}">${escapeHtml(app.name)}</a>`).join('<span aria-hidden="true"> · </span>');
    return `<p class="fd-screen-note"><span>${escapeHtml(t(env, 'Signing in to an app? Start from the app:'))} ${links}</span></p>`;
}
