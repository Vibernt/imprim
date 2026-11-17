// The two parts of every email, from one message (messages.mjs): plain text, and a fixed, branded HTML layout.
//
// The HTML part is built for mail clients, not browsers: one 560px column of presentation tables, every style inline,
// and a <style> block only for dark mode (clients that ignore it show the light version). Colours are the brand's look
// through Fire's palette engine, the same values as /assets/theme.css; the type set gives the font stack (no web fonts
// load). Every value is escaped; links are the issuer's own URLs or the brand's validated https links. No remote
// images: a PNG or JPEG logo travels inline (cid:), anything else gets the brand's initial in dots, drawn with cells.
import { translate, dateTimeIn } from '../../i18n/index.mjs';
import { escapeHtml as e } from '../../pages/ui.mjs';
import { initialRows } from '../../pages/dots.mjs';
import { resolveLook } from '../../branding/look.mjs';
import { paletteTokens, toneTokens, isDefaultTone } from '../../../public/fire/js/palettes.js';
import { getTypeface } from '../../../public/fire/js/typefaces.js';
import { EMAILS, SECURITY, WORDS } from './messages.mjs';
import { deviceText } from '../../lib/device.mjs';
// Subjects are one line: control characters, line and paragraph separators and bidirectional overrides become spaces.
const oneLine = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
// Values for one message in one locale: timestamps written out, everything else as given.
function values(locale, vars) {
    return Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, key === 'time' ? dateTimeIn(locale, value) : key === 'device' ? deviceText(value, (id, v) => translate(locale, id, v)) : value]));
}
// The brand's footer lines, as plain text: its own words, the help contact, the legal name.
export function footerLines(locale, branding, copy) {
    return [copy, branding.support_email ? translate(locale, WORDS.help, { contact: branding.support_email }) : branding.support_url ? translate(locale, WORDS.help, { contact: branding.support_url }) : null,
        branding.legal_name ? `© ${branding.legal_name}` : null].filter(Boolean);
}
export function subjectOf(kind, locale, { realmName, vars }) {
    const message = EMAILS[kind], subject = translate(locale, message.subject, vars);
    return oneLine(message.prefix ? `${realmName}: ${subject}` : subject);
}
export function renderText(kind, locale, { vars, links, footer }) {
    const message = EMAILS[kind], all = { ...values(locale, vars), ...links };
    const blocks = [...(message.before || []).map(id => translate(locale, id, all)), ...(message.link ? [links[message.link]] : []),
        ...(message.after || []).map(id => translate(locale, id, all)), ...(message.security ? [translate(locale, SECURITY, all)] : [])];
    return blocks.join('\n\n') + (message.footer && footer.length ? `\n\n--\n${footer.join('\n')}` : '');
}

// --- HTML ------------------------------------------------------------------------------------------------------------
const mix = (a, b, weight) => {
    const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    return '#' + [0, 1, 2].map(i => Math.round(channel(a, i) * weight + channel(b, i) * (1 - weight)).toString(16).padStart(2, '0')).join('');
};
const HEX = /^#[0-9a-f]{6}$/i;
// Light and dark colours from Fire's palette engine. Muted text is ink mixed into the page, as Fire's own muted tone.
export function emailColors(look) {
    const tokens = isDefaultTone(look.tone) ? paletteTokens(look.palette, { contrast: look.contrast }) : toneTokens(paletteTokens(look.palette, { contrast: look.contrast }), look.tone);
    const scheme = index => {
        const pick = name => HEX.test(tokens[name]?.[index]) ? tokens[name][index] : (index ? '#ffffff' : '#000000');
        const colors = { page: pick('--fd-bg'), card: pick('--fd-surface'), line: pick('--fd-line'), ink: pick('--fd-ink'), accent: pick('--fd-accent'),
            onAccent: pick('--fd-accent-contrast'), link: pick('--fd-accent-text') };
        return { ...colors, muted: mix(colors.ink, colors.page, 0.64), faint: mix(colors.line, colors.page, 0.6) };
    };
    const light = scheme(0), dark = scheme(1);
    return look.theme === 'dark' ? { light: dark, dark: null } : look.theme === 'light' ? { light, dark: null } : { light, dark };
}
const stack = family => `'${family}',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
// The brand's initial in a 5×7 grid of cells, lit in the accent: the same mark pages draw when no logo is uploaded.
function dotMark(name, c) {
    const cell = lit => `<td class="${lit ? 'im-dot' : 'im-dot-off'}" width="4" height="4" bgcolor="${lit ? c.accent : c.faint}" style="width:4px;height:4px;padding:0;font-size:0;line-height:0;background:${lit ? c.accent : c.faint};border-radius:2px">&nbsp;</td>`;
    return `<table role="presentation" aria-hidden="true" cellpadding="0" cellspacing="1" border="0" style="border-collapse:separate;border-spacing:1px">${initialRows(name).map(row => `<tr>${[...row].map(bit => cell(bit === '1')).join('')}</tr>`).join('')}</table>`;
}
function brandRow(name, logos, c, fonts) {
    if (logos.light) return `<img class="im-logo-light" src="cid:${logos.light}" alt="${e(name)}" height="32" style="display:block;height:32px;width:auto;max-width:240px;border:0;outline:none;text-decoration:none">` +
        (logos.dark ? `<!--[if !mso]><!--><img class="im-logo-dark" src="cid:${logos.dark}" alt="${e(name)}" height="32" style="display:none;height:32px;width:auto;max-width:240px;border:0;outline:none;text-decoration:none;mso-hide:all"><!--<![endif]-->` : '');
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding:0 10px 0 0">${dotMark(name, c)}</td>` +
        `<td valign="middle" class="im-ink" style="font-family:${fonts.display};font-size:17px;font-weight:600;line-height:1.2;color:${c.ink}">${e(name)}</td></tr></table>`;
}
// Text with its *_url values as links. The translation is escaped first, then each link is inserted escaped.
function linked(text, links, c) {
    // One pass, longest first, so a link is never matched inside a longer one (/account inside /account/agents).
    const urls = [...new Set(Object.values(links).filter(Boolean).map(url => e(url)))].sort((a, b) => b.length - a.length);
    if (!urls.length) return e(text);
    const pattern = new RegExp(urls.map(url => url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    return e(text).replace(pattern, url => `<a class="im-link" href="${url}" style="color:${c.link};text-decoration:underline;word-break:break-all">${url}</a>`);
}
export function renderHtml(kind, locale, { vars, links, branding, name, logos = {}, footer, lang }) {
    const message = EMAILS[kind], look = resolveLook(branding.look), { light: c, dark } = emailColors(look), type = getTypeface(look.type);
    const fonts = { sans: stack(type.sans), display: stack(type.display) };
    const radius = Math.round(12 * look.corners), buttonRadius = Math.round(8 * look.corners);
    const all = { ...values(locale, vars), ...links }, say = id => translate(locale, id, all);
    const p = (html, extra = '') => `<p class="im-ink" style="margin:0 0 16px;font-family:${fonts.sans};font-size:15px;line-height:1.6;color:${c.ink}${extra}">${html}</p>`;
    const small = html => `<p class="im-muted" style="margin:0 0 16px;font-family:${fonts.sans};font-size:13px;line-height:1.6;color:${c.muted}">${html}</p>`;
    const button = (label, url) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td class="im-button" bgcolor="${c.accent}" style="border-radius:${buttonRadius}px;background:${c.accent}">` +
        `<a class="im-button-text" href="${e(url)}" style="display:inline-block;padding:12px 22px;font-family:${fonts.sans};font-size:15px;font-weight:600;line-height:1;color:${c.onAccent};text-decoration:none;border-radius:${buttonRadius}px">${e(label)}</a></td></tr></table>`;
    const heading = translate(locale, message.heading, all);
    const body = [`<h1 class="im-ink" style="margin:0 0 16px;font-family:${fonts.display};font-size:22px;font-weight:600;line-height:1.3;color:${c.ink}">${e(heading)}</h1>`,
        ...(message.before || []).map(id => p(linked(say(id), links, c))),
        ...(message.link ? [button(translate(locale, message.button, all), links[message.link]), small(`${e(translate(locale, WORDS.paste))}<br>${linked(links[message.link], { link: links[message.link] }, c)}`)] : []),
        ...(message.after || []).map(id => small(linked(say(id), links, c))),
        ...(message.review ? [button(translate(locale, WORDS.review), links.account_url)] : []),
        ...(message.security ? [small(linked(say(SECURITY), links, c))] : [])].join('');
    const legal = [branding.privacy_url && `<a class="im-muted" href="${e(branding.privacy_url)}" style="color:${c.muted};text-decoration:underline">${e(translate(locale, WORDS.privacy))}</a>`,
        branding.terms_url && `<a class="im-muted" href="${e(branding.terms_url)}" style="color:${c.muted};text-decoration:underline">${e(translate(locale, WORDS.terms))}</a>`].filter(Boolean).join(' · ');
    const foot = [...footer.map(line => e(line)), legal, `${e(translate(locale, WORDS.poweredBy))} Imprim`].filter(Boolean).join('<br>');
    // Clients that support it switch to the dark colours; the rest keep the light ones, which every client can read.
    const darkCss = dark ? `@media (prefers-color-scheme: dark){.im-page{background:${dark.page}!important}.im-card{background:${dark.card}!important;border-color:${dark.line}!important}` +
        `.im-ink{color:${dark.ink}!important}.im-muted{color:${dark.muted}!important}.im-link{color:${dark.link}!important}.im-button{background:${dark.accent}!important}` +
        `.im-button-text{color:${dark.onAccent}!important}.im-dot{background:${dark.accent}!important}.im-dot-off{background:${dark.faint}!important}` +
        (logos.dark ? '.im-logo-light{display:none!important}.im-logo-dark{display:block!important}' : '') + '}' : '';
    const scheme = dark ? 'light dark' : look.theme === 'dark' ? 'dark' : 'light';
    const preheader = e(say((message.before || [])[0] || message.heading));
    return `<!doctype html><html lang="${e(lang)}" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<meta name="color-scheme" content="${scheme}"><meta name="supported-color-schemes" content="${scheme}"><title>${e(heading)}</title>` +
        `<style>:root{color-scheme:${scheme};supported-color-schemes:${scheme}}body{margin:0;padding:0}${darkCss}</style></head>` +
        `<body class="im-page" style="margin:0;padding:0;background:${c.page}">` +
        `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${preheader}</div>` +
        `<table role="presentation" class="im-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background:${c.page}"><tr><td align="center" style="padding:32px 16px">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">` +
        `<tr><td style="padding:0 4px 20px">${brandRow(name, logos, c, fonts)}</td></tr>` +
        `<tr><td class="im-card" bgcolor="${c.card}" style="background:${c.card};border:1px solid ${c.line};border-radius:${radius}px;padding:32px 28px">${body}</td></tr>` +
        `<tr><td class="im-muted" align="center" style="padding:20px 8px 0;font-family:${fonts.sans};font-size:12px;line-height:1.6;color:${c.muted}">${foot}</td></tr>` +
        `</table></td></tr></table></body></html>`;
}
