import { t } from '../i18n/index.mjs';
import { checkEmailAddress } from '../auth/check-email-state.mjs';
import { signInAgainHref } from './next-steps.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { tHtml } from '../i18n/index.mjs';
import { pendingRequest } from '../oidc/requests.mjs';
import { page } from './layout.mjs';
import { button, escapeHtml, field, heading, result } from './ui.mjs';

export function signupFields(env) {
    return `<div id="signup-fields" hidden>${field({ id: 'workspace-name', name: 'workspace_name', type: 'text', size: 'lg',
        label: t(env, 'Workspace name'), hint: t(env, 'Optional. Leave blank to use a name based on your email.') })}</div>`;
}

export function signupHeading(env) {
    return `<div id="signup-head" hidden>${heading(t(env, 'Create an account'))}</div>`;
}

export function signupButtons(env) {
    return button(t(env, 'Email me a link'), { id: 'send-signup', type: 'button', value: 'signup', variant: 'primary', size: 'lg', block: true, icon: 'mail', hidden: true, disabled: true });
}
export function signupFooter(env, client) {
    const app = brandingFor(env, client).name || client.id;
    return `<footer class="fd-card-foot" id="signup-foot"><p class="fd-body" id="open-signup-line">${tHtml(env, 'New to {app}? <0>Create an account</0>', { app },
        [inner => `<button class="fd-link" id="open-signup" type="button">${inner}</button>`])}</p>
<button class="fd-link" id="close-signup" type="button" hidden>${escapeHtml(t(env, 'Back to sign-in'))}</button></footer>`;
}

export async function checkEmailPage(request, env, id) {
    const pending = id === null ? null : await pendingRequest(env, request, id);
    const email = checkEmailAddress(request, id || '');
    const description = email ? t(env, 'If {email} can sign in here, a link is on its way.', { email })
        : t(env, 'If this address can sign in here, a link arrives within a minute.');
    return page(t(env, 'Check your email'), result('mail', 'accent', t(env, 'Check your email'), description) +
        `<p class="fd-screen-note">${escapeHtml(t(env, 'Open it in this browser. The link works once and expires in 15 minutes.'))}</p>
<a class="fd-link" href="${escapeHtml(id ? signInAgainHref(id) : '/login')}">${escapeHtml(t(env, 'Use a different email'))}</a>`, { client: pending?.client });
}

export async function pendingSignupPage(request, env, id) {
    const { client } = await pendingRequest(env, request, id);
    const title = t(env, 'Your request is waiting for approval');
    return page(title, result('clock', 'accent', title, t(env, 'We’ll email you.')), { client });
}
