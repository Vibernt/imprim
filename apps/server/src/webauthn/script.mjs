// Browser side of the passkey ceremonies (served as /assets/passkey.js; CSP script-src 'self'). Its messages are
// translated per language (/assets/passkey.js?lang=de; i18n localizeScript).
import { msg, localizeScript } from '../i18n/index.mjs';
const MESSAGES = [msg('The passkey step didn’t finish. Try again.'), msg('Passkey added. Save these recovery codes now. Each works once, and they are not shown again: ')];
export const passkeyScriptFor = locale => localizeScript(passkeyScript, locale, MESSAGES);
export const passkeyScript = `
const b64=buf=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
const csrf=()=>(document.cookie.match(/(?:^|; )__Host-vi_csrf=([^;]+)/)||[])[1]||'';
const say=text=>{const m=document.getElementById('message');if(m)m.textContent=text;};
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error_description||'The passkey step didn’t finish. Try again.');return j;}
async function assertWith(extra){
 const o=(await post('/v1/auth/passkey/options',extra)).publicKey;
 const c=await navigator.credentials.get({publicKey:{...o,challenge:unb64(o.challenge),allowCredentials:o.allowCredentials.map(x=>({...x,id:unb64(x.id)}))}});
 const r=c.response;
 return post('/v1/auth/passkey/verify',{...extra,id:c.id,clientDataJSON:b64(r.clientDataJSON),authenticatorData:b64(r.authenticatorData),signature:b64(r.signature),userHandle:r.userHandle&&r.userHandle.byteLength?b64(r.userHandle):undefined});
}
function wire(id,run){const b=document.getElementById(id);if(!b)return;if(!window.PublicKeyCredential){b.hidden=true;return;}
 b.addEventListener('click',async e=>{e.preventDefault();b.disabled=true;try{await run(b);}catch(error){say(error.message);b.disabled=false;}});}
wire('passkey-sign-in',async b=>{location.assign((await assertWith({purpose:'login',request_id:b.dataset.requestId})).redirect);});
wire('passkey-mfa',async b=>{location.assign((await assertWith({purpose:'mfa',request_id:b.dataset.requestId||undefined,next:b.dataset.next||undefined})).redirect);});
wire('passkey-add',async()=>{
 const o=(await post('/account/passkeys/options',{})).publicKey;
 const c=await navigator.credentials.create({publicKey:{...o,challenge:unb64(o.challenge),user:{...o.user,id:unb64(o.user.id)},excludeCredentials:o.excludeCredentials.map(x=>({...x,id:unb64(x.id)}))}});
 const added=await post('/account/passkeys/register',{name:(document.getElementById('passkey-name')||{}).value,clientDataJSON:b64(c.response.clientDataJSON),attestationObject:b64(c.response.attestationObject)});
 if(!added.recovery_codes.length){location.reload();return;}
 const m=document.getElementById('message');m.textContent='Passkey added. Save these recovery codes now. Each works once, and they are not shown again: '+added.recovery_codes.join('  ');
});`;
