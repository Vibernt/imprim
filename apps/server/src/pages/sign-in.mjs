import { signInSettings } from '../oidc/sign-in-methods.mjs';
import { page, escapeHtml } from './layout.mjs';
import { cookies, cookie, BROWSER_COOKIE } from '../auth/session.mjs';
import { randomToken } from '../lib/crypto.mjs';
import { tokenShape } from '../lib/http.mjs';
const challengeConfigured = env => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
// One form serves email links and passwords: the button pressed chooses the action (see signInScript).
const emailForm = (env, requestId, { link, password }) => `<form id="email-form"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label for="email">Email</label><input id="email" type="email" name="email" autocomplete="${password ? 'username' : 'email'}" required maxlength="254">
${password ? '<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" maxlength="1024">' : ''}
${challengeConfigured(env) ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="sign_in"></div>` : ''}
${password ? '<button id="password-sign-in" type="submit" value="password">Sign in</button>' : ''}
${link ? '<button id="send-link" type="submit" value="link">Email a sign-in link</button>' : ''}
${password ? '<button id="set-password" type="submit" value="set">New here, or forgot your password? Email me a link to set one</button>' : ''}</form>`;
export function signInPage(env, requestId = '', responseCookies = [], client = null) {
    const branding = client ? JSON.parse(client.branding) : {};
    const methods = client ? signInSettings(client).methods : ['email'];
    const email = methods.includes('email'), password = methods.includes('password');
    const controls = methods.filter(method => method !== 'password' || !email).map(method => ['email', 'password'].includes(method) ? emailForm(env, requestId, { link: email, password })
        : method === 'passkey' ? `<p><button id="passkey-sign-in" type="button" data-request-id="${escapeHtml(requestId)}">Sign in with a passkey</button></p>`
        : ['github', 'google'].includes(method) ? `<p><a href="/v1/auth/${method}/start?request_id=${encodeURIComponent(requestId)}">Sign in with ${method === 'github' ? 'GitHub' : 'Google'}</a></p>`
        : env.PROVIDERS?.[method] ? `<p><a href="/v1/auth/provider/${method}/start?request_id=${encodeURIComponent(requestId)}">Sign in with ${escapeHtml(env.PROVIDERS[method].name || method)}</a></p>` : '').join('\n');
    return page('Sign in', `<h1>Sign in to ${escapeHtml(branding.name || env.REALM.display_name)}</h1>
<section id="request" data-request-id="${escapeHtml(requestId)}">${controls}${client ? '' : '<p>Operator sign-in uses email only.</p>'}</section>
<section id="confirm" hidden><h2>Confirm sign-in</h2><p>Choose Sign in to use the emailed link. Keep this in the browser where you started.</p><button id="verify" type="button">Sign in</button></section>
<p id="message" role="status"></p>`, { cookies: responseCookies, script: methods.includes('passkey') ? ['/assets/sign-in.js', '/assets/passkey.js'] : '/assets/sign-in.js', turnstile: (email || password) && challengeConfigured(env) });
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
