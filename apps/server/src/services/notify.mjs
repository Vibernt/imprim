// Security notices to the account's own address. Sent after the response; a failure is logged, never fatal.
export function notify(env, ctx, to, subject, text) {
    if (!env.EMAIL?.send || !env.EMAIL_FROM || !ctx) return;
    ctx.waitUntil(env.EMAIL.send({ from: env.EMAIL_FROM, to, subject: `${env.REALM.display_name}: ${subject}`,
        text: `${text}\n\nIf this was not you, sign in with an email link at ${env.ISSUER}/login, then review your account at ${env.ISSUER}/account.` })
        .catch(error => console.error(JSON.stringify({ type: 'notice_failed', code: error?.code || 'send_failed' }))));
}
