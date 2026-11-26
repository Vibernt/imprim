// Writes every email kind in every shipped language as HTML and text, to look at in a browser in light and dark mode.
//   node scripts/email-preview.mjs [out-dir] [branding.json]
// No network and no database: a sample realm, sample values, and the brand you pass (or a default one).
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { composeEmail } from '../apps/server/src/services/email/send.mjs';
import { EMAILS } from '../apps/server/src/services/email/messages.mjs';
import { LANGUAGES, LANGUAGE_NAMES } from '../apps/server/src/i18n/index.mjs';
const out = process.argv[2] || 'email-preview', branding = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8'))
    : { name: 'Acme', legal_name: 'Acme Ltd', support_email: 'help@acme.example', privacy_url: 'https://acme.example/privacy', terms_url: 'https://acme.example/terms' };
const env = { ISSUER: 'https://id.example.com', EMAIL_FROM: 'signin@example.com', REALM: { id: 'preview', display_name: branding.name || 'Acme', branding },
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
const vars = { device: 'Chrome on macOS', place: 'Berlin, DE', time: Date.UTC(2026, 10, 17, 9, 30), reason: 'Lost phone, identity checked by video call',
    agent: 'Claude Code', machine: 'Editorial bot', app: 'Notes', workspace: 'team-one', scopes: 'read write', name: 'Work laptop', email: 'dana@example.com', old: 'dana@old.example', new: 'dana@example.com',
    inviter: 'lee@example.com', products: 'notes, projects' };
const links = { link: 'https://id.example.com/login#token=EXAMPLE', agents_url: 'https://id.example.com/account/agents', invitation_url: 'https://app.example.com/sign-in' };
await mkdir(out, { recursive: true });
const index = [];
for (const locale of LANGUAGES) for (const kind of Object.keys(EMAILS)) {
    // {name} is the brand's name in link emails, and a passkey's or authenticator's name in notices.
    const mail = await composeEmail(env, { kind, to: 'dana@example.com', locale, vars: EMAILS[kind].link ? { ...vars, name: undefined } : vars, links, branding });
    const base = `${locale}-${kind}`;
    await writeFile(`${out}/${base}.html`, mail.html); await writeFile(`${out}/${base}.txt`, `Subject: ${mail.subject}\n\n${mail.text}\n`);
    index.push(`<li><a href="${base}.html">${LANGUAGE_NAMES[locale]}: ${kind}</a> (<a href="${base}.txt">text</a>)</li>`);
}
await writeFile(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>Imprim emails</title><ul>${index.join('')}</ul>`);
console.log(`Wrote ${index.length} emails to ${out}/index.html`);
