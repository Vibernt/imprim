import { brandingFor } from '../branding/tokens.mjs';
import { t } from '../i18n/index.mjs';
import { page } from './layout.mjs';
import { signInAgainHref } from './next-steps.mjs';
import { heading, linkButton } from './ui.mjs';

export const inviteOnlyText = (env, app) => t(env,
    '{app} is invite-only for now. Use the address you were invited with, or ask the person who invited you.', { app });

function refusalPage(env, { client, row }, title, description, cookies) {
    return page(t(env, 'Sign in'), heading(title, description) +
        linkButton(t(env, 'Sign in another way'), signInAgainHref(row.id), { variant: 'primary', size: 'lg', block: true }),
    { client, cookies });
}

export function platformAddressPage(env, pending, cookies = []) {
    return refusalPage(env, pending, t(env, 'Sign-in stopped'),
        t(env, 'This address manages {realm}, so it can\'t sign in to apps. Use another address.', { realm: env.REALM.display_name }), cookies);
}

export function notInvitedPage(env, pending, email, cookies) {
    const app = brandingFor(env, pending.client).name || env.REALM.display_name;
    return refusalPage(env, pending, t(env, '{email} isn\'t invited to {app}', { email, app }),
        inviteOnlyText(env, app), cookies);
}

// The browser has already POSTed the proof. Show its same-origin HTML response in place, without
// copying scripts or putting a refusal flag, email or credential into the URL or a cookie.
export const showSignInRefusal = `async function showSignInRefusal(response) {
 if(!response.ok||!response.headers.get('content-type')?.startsWith('text/html'))return false;
 const page=new DOMParser().parseFromString(await response.text(),'text/html');
 const content=page.querySelector('main');
 document.querySelector('main').replaceWith(content);
 document.title=page.title;
 document.documentElement.lang=page.documentElement.lang;
 content.querySelector('a.fd-btn').focus();
 return true;
}`;
