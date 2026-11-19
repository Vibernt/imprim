import { t } from '../i18n/index.mjs';
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
    return `${button(t(env, 'Email me a link'), { id: 'send-signup', type: 'button', value: 'signup', variant: 'primary', size: 'lg', block: true, icon: 'mail', hidden: true, disabled: true })}
<div class="fd-row" data-justify="center">
<button class="fd-btn-text" id="open-signup" type="button">${escapeHtml(t(env, 'Create an account'))}</button>
<button class="fd-btn-text" id="close-signup" type="button" hidden>${escapeHtml(t(env, 'Back to sign-in'))}</button>
</div>`;
}

export async function checkEmailPage(request, env, id) {
    const pending = id === null ? null : await pendingRequest(env, request, id);
    return page(t(env, 'Check your email'), result('mail', 'accent', t(env, 'Check your email'), t(env, 'If this address can sign in here, a link arrives within a minute.')) +
        `<p class="fd-screen-note">${escapeHtml(t(env, 'Open it in this browser. The link works once and expires in 15 minutes.'))}</p>`, { client: pending?.client });
}

export async function pendingSignupPage(request, env, id) {
    const { client } = await pendingRequest(env, request, id);
    const title = t(env, 'Your request is waiting for approval');
    return page(title, result('clock', 'accent', title, t(env, 'We’ll email you.')), { client });
}
