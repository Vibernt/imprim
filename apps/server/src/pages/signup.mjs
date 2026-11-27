import { t, tHtml } from '../i18n/index.mjs';
import { checkEmailAddress } from '../auth/check-email-state.mjs';
import { signInAgainHref } from './next-steps.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { pendingRequest } from '../oidc/requests.mjs';
import { page } from './layout.mjs';
import { attrs, button, escapeHtml, field, heading, linkButton, orDivider, result } from './ui.mjs';

import { liveSignupEnabled, signupProviderNames } from '../auth/signup-policy.mjs';
import { providerMark } from './provider-marks.mjs';
import { inviteOnlyText } from './sign-in-refusal.mjs';

export const signupProviderOrigins = Object.freeze({ google: 'https://accounts.google.com', github: 'https://github.com' });

export function signupFields(env, active) {
    return `<div id="signup-fields"${attrs({ hidden: !active })}>${field({ id: 'workspace-name', name: 'workspace_name', type: 'text', size: 'lg',
        label: t(env, 'Workspace name'), hint: t(env, 'Optional. Leave blank to use a name based on your email.') })}</div>`;
}

export function signupHeading(env, active) {
    return `<div id="signup-head"${attrs({ hidden: !active })}>${heading(t(env, 'Create an account'))}</div>`;
}

export function signupButtons(env, providers, active) {
    const email = button(t(env, 'Email me a link'), { id: 'send-signup', type: active ? 'submit' : 'button', value: 'signup',
        variant: 'primary', size: 'lg', block: true, icon: 'mail', hidden: !active, disabled: !active });
    if (!providers.length) return email;
    // Keep the email submitter first in the form so Enter chooses it.
    const controls = providers.map(provider => {
        const label = t(env, 'Sign up with {provider}', { provider: signupProviderNames[provider] });
        return button(label, { mark: providerMark(provider), type: active ? 'submit' : 'button', variant: 'outline',
            size: 'lg', block: true, 'data-signup-provider': true, disabled: !active,
            formaction: `/v1/auth/${provider}/signup`, formmethod: 'post', formnovalidate: true });
    });
    return email + `<div id="signup-providers" class="fd-stack" data-gap="3"${attrs({ hidden: !active })}>
${orDivider(env)}${controls.join('')}</div>`;
}

export function signupFooter(env, client, active) {
    const app = brandingFor(env, client).name || client.id;
    return `<footer class="fd-card-foot" id="signup-foot"><p class="fd-body" id="open-signup-line"${attrs({ hidden: active })}>${tHtml(env, 'New to {app}? <0>Create an account</0>', { app },
        [inner => `<button class="fd-link" id="open-signup" type="button">${inner}</button>`])}</p>
<button class="fd-link" id="close-signup" type="button"${attrs({ hidden: !active })}>${escapeHtml(t(env, 'Back to sign-in'))}</button></footer>`;
}

export function noAccountPage(env, { client, row }, email, clearCookie) {
    const app = brandingFor(env, client).name || env.REALM.display_name;
    const title = t(env, 'No {app} account yet', { app });
    const href = signInAgainHref(row.id);
    const description = t(env, '{email} has no {app} account. Create one, or sign in another way if you use a different email.', { app, email });
    return page(t(env, 'Sign in'), heading(title, description) +
        linkButton(t(env, 'Create an account'), href + '&view=signup', { variant: 'primary', size: 'lg', block: true }) +
        `<div class="fd-row" data-justify="center"><a class="fd-link" href="${escapeHtml(href)}">${escapeHtml(t(env, 'Sign in another way'))}</a></div>`,
    { client, cookies: [clearCookie] });
}

export async function checkEmailPage(request, env, id) {
    const pending = id === null ? null : await pendingRequest(env, request, id);
    const email = checkEmailAddress(request, id || '');
    const description = email ? t(env, 'If {email} can sign in here, a link is on its way.', { email })
        : t(env, 'If this address can sign in here, a link arrives within a minute.');
    const client = pending?.client;
    const inviteNote = client?.signup_policy === 'invited' && !await liveSignupEnabled(env, client)
        ? `<p class="fd-screen-note">${escapeHtml(inviteOnlyText(env, brandingFor(env, client).name || env.REALM.display_name))}</p>` : '';
    return page(t(env, 'Check your email'), result('mail', 'accent', t(env, 'Check your email'), description) +
        inviteNote + `<p class="fd-screen-note">${escapeHtml(t(env, 'Open it in this browser. The link works once and expires in 15 minutes.'))}</p>
<a class="fd-link" href="${escapeHtml(id ? signInAgainHref(id) : '/login')}">${escapeHtml(t(env, 'Use a different email'))}</a>`, { client });
}

export async function pendingSignupPage(request, env, id) {
    const { client } = await pendingRequest(env, request, id);
    const title = t(env, 'Your request is waiting for approval');
    return page(title, result('clock', 'accent', title, t(env, 'We’ll email you.')), { client });
}
