import { signInSettings } from '../oidc/sign-in-methods.mjs';
import { page, escapeHtml } from './layout.mjs';
import { cookies, cookie, BROWSER_COOKIE } from '../auth/session.mjs';
import { randomToken } from '../lib/crypto.mjs';
import { tokenShape } from '../lib/http.mjs';
const challengeConfigured = env => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
const emailForm = (env, requestId) => `<form id="email-form"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label for="email">Email</label><input id="email" type="email" name="email" autocomplete="email" required maxlength="254">
${challengeConfigured(env) ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="sign_in"></div>` : ''}
<button id="send-link" type="submit">Email a sign-in link</button></form>`;
export function signInPage(env, requestId = '', responseCookies = [], client = null) {
    const branding = client ? JSON.parse(client.branding) : {};
    const methods = client ? signInSettings(client).methods : ['email'];
    const controls = methods.map(method => method === 'email' ? emailForm(env, requestId)
        : `<p><a href="/v1/auth/${method}/start?request_id=${encodeURIComponent(requestId)}">Sign in with ${method === 'github' ? 'GitHub' : 'Google'}</a></p>`).join('\n');
    return page('Sign in', `<h1>Sign in to ${escapeHtml(branding.name || env.REALM.display_name)}</h1>
<section id="request" data-request-id="${escapeHtml(requestId)}">${controls}${client ? '' : '<p>Operator sign-in uses email only.</p>'}</section>
<section id="confirm" hidden><h2>Confirm sign-in</h2><p>Choose Sign in to use the emailed link. Keep this in the browser where you started.</p><button id="verify" type="button">Sign in</button></section>
<p id="message" role="status"></p>`, { cookies: responseCookies, script: '/assets/sign-in.js', turnstile: methods.includes('email') && challengeConfigured(env) });
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
 event.preventDefault();const form=new FormData(event.target);const button=document.getElementById('send-link');button.disabled=true;
 try{
  const result=await fetch('/v1/auth/magic/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:form.get('email'),request_id:form.get('request_id'),turnstile:form.get('cf-turnstile-response')})});
  const body=await result.json();if(!result.ok)throw new Error(body.error_description||'Request failed.');
  location.assign('/check-email');
 }catch(error){message.textContent=error.message;button.disabled=false;window.turnstile?.reset();}
});`;
