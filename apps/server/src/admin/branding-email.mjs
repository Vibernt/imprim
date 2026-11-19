import { composeEmail } from '../services/email/send.mjs';

// A document preview of the saved look. The email renderer needs inline styling, so the preview gets its own
// sandboxed policy. The specimen contains no credentials, and never sends mail.
export async function sampleEmail(env) {
    const sample = await composeEmail(env, {
        kind: 'sign_in_link', locale: 'en', links: { link: '#sample' }
    });
    const html = (sample.attachments ?? []).reduce((body, logo) =>
        body.replaceAll(`src="cid:${logo.contentId}"`, `src="data:${logo.type};base64,${logo.content}"`), sample.html);
    return new Response(html, { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
        'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    } });
}
