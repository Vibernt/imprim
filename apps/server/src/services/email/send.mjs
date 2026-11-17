// Sending one email: its locale, brand, both parts and the inline logo. Callers pick the kind (messages.mjs) and the
// values; links are built here from the issuer, so no caller can put another address in a button.
import { localeOf, brandCopyIn, htmlLang } from '../../i18n/index.mjs';
import { resolveBranding } from '../../branding/tokens.mjs';
import { realmId } from '../../realms/realm.mjs';
import { subjectOf, renderText, renderHtml, footerLines } from './render.mjs';
// PNG and JPEG show in every client that shows images; SVG and WebP do not (Gmail, Outlook), so those brands get dots.
const INLINE = ['image/png', 'image/jpeg'];
const base64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(text); };
async function inlineLogo(env, id, contentId) {
    if (!id) return null;
    const row = await env.DB.prepare('SELECT content_type,data FROM brand_assets WHERE realm_id=? AND id=?').bind(realmId(env), id).first();
    if (!row || !INLINE.includes(row.content_type)) return null;
    const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array(Array.isArray(row.data) ? row.data : row.data);
    return { content: base64(bytes), filename: `${contentId}.${row.content_type === 'image/png' ? 'png' : 'jpg'}`, type: row.content_type, disposition: 'inline', contentId };
}
// kind: a key of EMAILS. branding: the brand the email wears (an app's resolved branding, or the realm's by default).
// locale: the recipient's language (the request's by default). vars: the message's values; links: its *_url values.
export async function composeEmail(env, { kind, to, vars = {}, links = {}, branding = resolveBranding(env.REALM?.branding || {}, {}), locale = localeOf(env) }) {
    const name = branding.name || env.REALM.display_name;
    // {name} is the brand's unless the message names something else (a passkey, an authenticator).
    const values = { name, ...Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== undefined && value !== null)) };
    const all = { login_url: `${env.ISSUER}/login`, account_url: `${env.ISSUER}/account`, ...links };
    const footer = footerLines(locale, branding, brandCopyIn(locale, branding, 'footer'));
    const light = await inlineLogo(env, branding.logo_light, 'logo-light'), dark = light ? await inlineLogo(env, branding.logo_dark, 'logo-dark') : null;
    const logos = { light: light?.contentId, dark: dark?.contentId };
    const mail = { from: env.EMAIL_FROM, to, subject: subjectOf(kind, locale, { realmName: env.REALM.display_name, vars: values }),
        text: renderText(kind, locale, { vars: values, links: all, footer }),
        html: renderHtml(kind, locale, { vars: values, links: all, branding, name, logos, footer, lang: htmlLang(locale, branding.locale) }) };
    const attachments = [light, dark].filter(Boolean);
    return attachments.length ? { ...mail, attachments } : mail;
}
export const sendEmail = async (env, options) => env.EMAIL.send(await composeEmail(env, options));
