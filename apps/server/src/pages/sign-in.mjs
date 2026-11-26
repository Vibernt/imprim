import { signInSettings } from '../oidc/sign-in-methods.mjs';
import { page, escapeHtml } from './layout.mjs';
import { field, button, orDivider as or } from './ui.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { t, msg, brandCopy, localizeScript, scriptPath, useLocale } from '../i18n/index.mjs';
import { cookies, cookie, BROWSER_COOKIE } from '../auth/session.mjs';
import { randomToken } from '../lib/crypto.mjs';
import { tokenShape } from '../lib/http.mjs';
import { signupFields, signupHeading, signupButtons } from './signup.mjs';
import { pendingRequest } from '../oidc/requests.mjs';
import { liveSignupEnabled } from '../auth/signup-policy.mjs';
import { AppError } from '../lib/errors.mjs';
import { appLinksNote } from './next-steps.mjs';
const challengeConfigured = env => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
// One form serves email links and passwords: the button pressed chooses the action (see signInScript).
function emailForm(env, requestId, { link, password, signup }) {
    // The set-password action comes after Sign in, so Enter in a field signs in (the first submit button is the default).
    const passwordField = password ? field({ id: 'password', label: t(env, 'Password'), type: 'password', name: 'password', size: 'lg', autocomplete: 'current-password', maxlength: 1024 }) : '';
    const signInButtons = `${password ? button(t(env, 'Sign in'), { id: 'password-sign-in', value: 'password', variant: 'primary', size: 'lg', block: true }) : ''}
${link ? button(t(env, 'Email me a link'), { id: 'send-link', value: 'link', variant: password ? 'outline' : 'primary', size: 'lg', block: true, icon: 'mail' }) : ''}
${password ? `<div class="fd-row" data-justify="center"><button class="fd-btn-text" id="set-password" type="submit" value="set">${escapeHtml(t(env, 'Set or reset password'))}</button></div>` : ''}`;
    return `<form class="fd-stack" data-gap="4" id="email-form" method="post"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
${field({ id: 'email', label: t(env, 'Email'), type: 'email', name: 'email', size: 'lg', autocomplete: password ? 'username' : 'email', required: true, maxlength: 254, placeholder: t(env, 'you@example.com') })}
${signup && password ? `<div data-sign-in-only>${passwordField}</div>` : passwordField}
${signup ? signupFields(env) : ''}${challengeConfigured(env) ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="sign_in"></div>` : ''}
${signup ? `<div id="sign-in-actions" class="fd-stack" data-gap="4" data-sign-in-only>${signInButtons}</div>${signupButtons(env)}` : signInButtons}</form>`;
}
export function signInPage(env, requestId = '', responseCookies = [], client = null, { signup = false, appLinks = '' } = {}) {
    useLocale(env, { client });
    const branding = brandingFor(env, client);
    const methods = client ? signInSettings(client).methods : ['email'];
    const email = methods.includes('email'), password = methods.includes('password');
    const providerLink = (href, label) => `<a class="fd-btn" data-variant="outline" data-size="lg" data-block href="${href}"><span>${escapeHtml(label)}</span></a>`;
    const controls = methods.filter(method => method !== 'password' || !email).map(method => ['email', 'password'].includes(method) ? emailForm(env, requestId, { link: email, password, signup })
        : method === 'passkey' ? button(t(env, 'Sign in with a passkey'), { id: 'passkey-sign-in', type: 'button', 'data-request-id': requestId, variant: 'outline', size: 'lg', block: true, icon: 'key-round' })
        : ['github', 'google'].includes(method) ? providerLink(`/v1/auth/${method}/start?request_id=${encodeURIComponent(requestId)}`, t(env, 'Sign in with {provider}', { provider: method === 'github' ? 'GitHub' : 'Google' }))
        : env.PROVIDERS?.[method] ? providerLink(`/v1/auth/provider/${method}/start?request_id=${encodeURIComponent(requestId)}`, t(env, 'Sign in with {provider}', { provider: env.PROVIDERS[method].name || method })) : '').filter(Boolean);
    // In the app's order; "or" separates the email form from the buttons around it.
    const divider = or(env), ordered = controls.flatMap((c, i) => c.startsWith('<form') ? [...(i > 0 ? [divider] : []), c, ...(i < controls.length - 1 ? [divider] : [])] : [c]);
    const heading = brandCopy(env, branding, 'sign_in_heading') || t(env, 'Sign in to {name}', { name: branding.name || env.REALM.display_name }), help = brandCopy(env, branding, 'sign_in_help');
    return page(t(env, 'Sign in'), `<header class="fd-screen-head" id="sign-in-head"><h1 class="fd-h1">${escapeHtml(heading)}</h1>${help ? `<p class="fd-muted">${escapeHtml(help)}</p>` : ''}</header>
${signup ? signupHeading(env) : ''}
<section id="request" class="fd-stack" data-gap="3" data-request-id="${escapeHtml(requestId)}">${ordered.join('\n')}${client ? '' : `<p class="fd-screen-note">${escapeHtml(t(env, 'Administrators sign in by email.'))}</p>${appLinks}`}</section>
<section id="confirm" class="fd-stack" data-gap="4" hidden><header class="fd-screen-head"><p class="fd-muted">${escapeHtml(t(env, 'Finish signing in with the link you opened. Keep this browser.'))}</p></header>${button(t(env, 'Sign in'), { id: 'verify', type: 'button', variant: 'primary', size: 'lg', block: true })}</section>
<p class="fd-small" id="message" role="status" aria-live="polite"></p>`, { client, cookies: responseCookies, script: methods.includes('passkey') ? [scriptPath(env, '/assets/sign-in.js'), scriptPath(env, '/assets/passkey.js')] : scriptPath(env, '/assets/sign-in.js'), turnstile: (email || password) && challengeConfigured(env) });
}
// /login is the administrators' sign-in. With the request_id of a sign-in still open in this browser (an email link, or
// "Sign in again" on a page that stopped), it is that app's sign-in page again, as /authorize showed it; any other
// request_id is ignored. Without one, it points people who meant to sign in to an app at the apps' own pages.
export async function loginPage(request, env, url) {
    const existing = cookies(request)[BROWSER_COOKIE], browser = tokenShape(existing) ? existing : randomToken();
    const responseCookies = [cookie(BROWSER_COOKIE, browser, 1800)];
    const id = url.searchParams.get('request_id');
    if (id && tokenShape(existing)) {
        try {
            const { row, client } = await pendingRequest(env, request, id);
            return signInPage(env, row.id, responseCookies, client, { signup: !row.agent_client_id && await liveSignupEnabled(env, client) });
        } catch (error) {
            if (!(error instanceof AppError) || error.status >= 500) throw error;
        }
    }
    return signInPage(env, '', responseCookies, null, { appLinks: await appLinksNote(env).catch(() => '') });
}
const MESSAGES = [msg('Sign-in failed.'), msg('Enter your password, or choose to get an email link.'), msg('Request failed.')];
export const signInScriptFor = locale => localizeScript(signInScript, locale, MESSAGES);
// Reading a fragment does not redeem it. Only the explicit click sends the token with a same-origin POST.
export const signInScript = `
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token');
if(token){history.replaceState(null,'',location.pathname);document.getElementById('request').hidden=true;document.getElementById('confirm').hidden=false;}
const message=document.getElementById('message');
const signupFields=document.getElementById('signup-fields');
const emailForm=document.getElementById('email-form');
const openSignup=document.getElementById('open-signup'), closeSignup=document.getElementById('close-signup');
function showSignup(active){
 const submit=document.getElementById('send-signup');
 const actions=document.getElementById('sign-in-actions');
 for(const node of emailForm.querySelectorAll('[data-sign-in-only]'))node.hidden=active;
 // Enter targets the first submit button, even if that button is hidden.
 for(const control of actions.querySelectorAll('button')){
  control.type=active?'button':'submit';
  control.disabled=active;
 }
 submit.type=active?'submit':'button';
 for(const node of emailForm.parentElement.children)if(node!==emailForm)node.hidden=active;
 document.getElementById('sign-in-head').hidden=active;
 document.getElementById('signup-head').hidden=!active;
 const password=document.getElementById('password');
 if(password)password.disabled=active;
 signupFields.hidden=submit.hidden=!active;
 openSignup.hidden=active;
 closeSignup.hidden=submit.disabled=!active;
 message.textContent='';
 document.getElementById('email').focus();
}
openSignup?.addEventListener('click',()=>showSignup(true));
closeSignup?.addEventListener('click',()=>showSignup(false));
document.getElementById('verify').addEventListener('click',async()=>{
 const button=document.getElementById('verify');button.disabled=true;
 try{
  const result=await fetch('/v1/auth/magic/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token, browser_response:true})});
  const body=await result.json();if(!result.ok)throw new Error(body.error_description||'Sign-in failed.');
  location.assign(body.redirect);
 }catch(error){
  // An expired or used link: show the sign-in form again, so a new link is one step away.
  message.textContent=error.message;button.disabled=false;
  document.getElementById('confirm').hidden=true;document.getElementById('request').hidden=false;
 }
});
emailForm?.addEventListener('submit',async(event)=>{
 event.preventDefault();const form=new FormData(event.target);const action=signupFields?.hidden===false?'signup':event.submitter?.value||'link';
 const buttons=[...event.target.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 const common={email:form.get('email'),request_id:form.get('request_id'),turnstile:form.get('cf-turnstile-response')};
 try{
  if(action==='password'){
   if(!form.get('password'))throw new Error('Enter your password, or choose to get an email link.');
   const result=await fetch('/v1/auth/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...common,password:form.get('password')})});
   const body=await result.json();if(!result.ok)throw new Error(body.error_description||'Sign-in failed.');
   location.assign(body.redirect);return;
  }
  const payload={...common,purpose:action==='set'?'password':'sign_in'};
  if(action==='signup'){payload.purpose='signup';payload.workspace_name=form.get('workspace_name');}
  const result=await fetch('/v1/auth/magic/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const body=await result.json();if(!result.ok)throw new Error(body.error_description||'Request failed.');
  location.assign(action==='signup'?'/check-email?request_id='+encodeURIComponent(common.request_id):'/check-email');
 }catch(error){message.textContent=error.message;buttons.forEach(b=>b.disabled=b.hidden||Boolean(b.closest('[data-sign-in-only][hidden]')));window.turnstile?.reset();}
});`;
