// Security notices to the account's own address, in the realm's brand and the recipient's language (the request's,
// unless the caller names one). Sent after the response; a failure is logged, never fatal, and never logs the message.
import { sendEmail } from './email/send.mjs';
export function notify(env, ctx, to, kind, vars = {}, { locale, links } = {}) {
    if (!env.EMAIL?.send || !env.EMAIL_FROM || !ctx) return;
    ctx.waitUntil(sendEmail(env, { kind, to, vars, links, ...(locale ? { locale } : {}) })
        .catch(error => console.error(JSON.stringify({ type: 'notice_failed', code: error?.code || 'send_failed' }))));
}
