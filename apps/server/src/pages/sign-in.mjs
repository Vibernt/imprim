import { signInSettings } from '../oidc/sign-in-methods.mjs';
import { page, escapeHtml } from './layout.mjs';
import { field, button, orDivider as or } from './ui.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { cookies, cookie, BROWSER_COOKIE } from '../auth/session.mjs';
import { randomToken } from '../lib/crypto.mjs';
import { tokenShape } from '../lib/http.mjs';
const challengeConfigured = env => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
// One form serves email links and passwords: the button pressed chooses the action (see signInScript).
function emailForm(env, requestId, { link, password }) {
    // The set-password action comes after Sign in, so Enter in a field signs in (the first submit button is the default).
    const passwordField = password ? field({ id: 'password', label: 'Password', type: 'password', name: 'password', size: 'lg', autocomplete: 'current-password', maxlength: 1024 }) : '';
    return `<form class="fd-stack" data-gap="4" id="email-form"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
${field({ id: 'email', label: 'Email', type: 'email', name: 'email', size: 'lg', autocomplete: password ? 'username' : 'email', required: true, maxlength: 254, placeholder: 'you@example.com' })}
${passwordField}${challengeConfigured(env) ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="sign_in"></div>` : ''}
${password ? button('Sign in', { id: 'password-sign-in', value: 'password', variant: 'primary', size: 'lg', block: true }) : ''}
${link ? button('Email me a link', { id: 'send-link', value: 'link', variant: password ? 'outline' : 'primary', size: 'lg', block: true, icon: 'mail' }) : ''}
${password ? '<div class="fd-row" data-justify="center"><button class="fd-btn-text" id="set-password" type="submit" value="set">Set or reset password</button></div>' : ''}</form>`;
}
export function signInPage(env, requestId = '', responseCookies = [], client = null) {
    const branding = brandingFor(env, client);
    const methods = client ? signInSettings(client).methods : ['email'];
    const email = methods.includes('email'), password = methods.includes('password');
    const providerLink = (href, label) => `<a class="fd-btn" data-variant="outline" data-size="lg" data-block href="${href}"><span>${escapeHtml(label)}</span></a>`;
    const controls = methods.filter(method => method !== 'password' || !email).map(method => ['email', 'password'].includes(method) ? emailForm(env, requestId, { link: email, password })
        : method === 'passkey' ? button('Sign in with a passkey', { id: 'passkey-sign-in', type: 'button', 'data-request-id': requestId, variant: 'outline', size: 'lg', block: true, icon: 'key-round' })
        : ['github', 'google'].includes(method) ? providerLink(`/v1/auth/${method}/start?request_id=${encodeURIComponent(requestId)}`, `Sign in with ${method === 'github' ? 'GitHub' : 'Google'}`)
        : env.PROVIDERS?.[method] ? providerLink(`/v1/auth/provider/${method}/start?request_id=${encodeURIComponent(requestId)}`, `Sign in with ${env.PROVIDERS[method].name || method}`) : '').filter(Boolean);
    // In the app's order; "or" separates the email form from the buttons around it.
    const ordered = controls.flatMap((c, i) => c.startsWith('<form') ? [...(i > 0 ? [or] : []), c, ...(i < controls.length - 1 ? [or] : [])] : [c]);
    const heading = branding.copy.sign_in_heading || `Sign in to ${branding.name || env.REALM.display_name}`;
    return page('Sign in', `<div class="fd-stack" data-gap="1-5"><h1 class="fd-h1">${escapeHtml(heading)}</h1>${branding.copy.sign_in_help ? `<p class="fd-muted">${escapeHtml(branding.copy.sign_in_help)}</p>` : ''}</div>
<section id="request" class="fd-stack" data-gap="3" data-request-id="${escapeHtml(requestId)}">${ordered.join('\n')}${client ? '' : '<p class="fd-small fd-muted">Administrators sign in by email.</p>'}</section>
<section id="confirm" class="fd-stack" data-gap="4" hidden><p class="fd-muted">Finish signing in with the link you opened. Keep this browser.</p>${button('Sign in', { id: 'verify', type: 'button', variant: 'primary', size: 'lg', block: true })}</section>
<p class="fd-small" id="message" role="status" aria-live="polite"></p>`, { client, cookies: responseCookies, script: methods.includes('passkey') ? ['/assets/sign-in.js', '/assets/passkey.js'] : '/assets/sign-in.js', turnstile: (email || password) && challengeConfigured(env) });
}
export function loginPage(request, env) {
    const existing = cookies(request)[BROWSER_COOKIE], browser = tokenShape(existing) ? existing : randomToken();
    return signInPage(env, '', [cookie(BROWSER_COOKIE, browser, 1800)]);
}
// Reading a fragment does not redeem it. Only the explicit click sends the token with a same-origin POST.
export const signInScript = `
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token');
if(token){history.replaceState(null,'',location.pathname);document.getElementById('request').hidden=true;document.getElementById('confirm').hidden=false;}
const message=document.getElementById('message');
document.getElementById('verify').addEventListener('click',async()=>{
 const button=document.getElementById('verify');button.disabled=true;
 try{
  const result=await fetch('/v1/auth/magic/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token, browser_response:true})});
  const body=await result.json();if(!result.ok)throw new Error(body.error_description||'Sign-in failed.');
  location.assign(body.redirect);
 }catch(error){message.textContent=error.message;button.disabled=false;}
});
document.getElementById('email-form')?.addEventListener('submit',async(event)=>{
 event.preventDefault();const form=new FormData(event.target);const action=event.submitter?.value||'link';
 const buttons=[...event.target.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 const common={email:form.get('email'),request_id:form.get('request_id'),turnstile:form.get('cf-turnstile-response')};
 try{
  if(action==='password'){
   if(!form.get('password'))throw new Error('Enter your password, or choose to get an email link.');
   const result=await fetch('/v1/auth/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...common,password:form.get('password')})});
   const body=await result.json();if(!result.ok)throw new Error(body.error_description||'Sign-in failed.');
   location.assign(body.redirect);return;
  }
  const result=await fetch('/v1/auth/magic/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...common,purpose:action==='set'?'password':'sign_in'})});
  const body=await result.json();if(!result.ok)throw new Error(body.error_description||'Request failed.');
  location.assign('/check-email');
 }catch(error){message.textContent=error.message;buttons.forEach(b=>b.disabled=false);window.turnstile?.reset();}
});`;
