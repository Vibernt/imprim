// Server-rendered responses to legacy admin forms use Fire's app shell.
import { escapeHtml as e } from '../pages/layout.mjs';
import { shellPage } from '../pages/shell.mjs';
import { linkButton, callout } from '../pages/ui.mjs';

const ART = { clients: 'grid', services: 'waves', users: 'orbit', workspaces: 'terrain', branding: 'halftone', audit: 'rain', settings: 'terrain', keys: 'spark', realms: 'terrain' };
const json = value => `<pre class="fd-codeblock-body fd-code">${e(JSON.stringify(value, null, 2))}</pre>`;

export function adminPage(title, body, { description = '', active = '' } = {}) {
    const response = shellPage(title, body, { area: 'admin', active, description, art: ART[active] });
    response.headers.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return response;
}

const card = body => `<article class="fd-card">${body}</article>`;

export function resultPage(result) {
    return adminPage('Done', (result.client_secret ? callout('Copy the new client secret now', 'It is shown once. Store it in your app’s secrets before you leave this page.', { tone: 'warning' }) : '') + card(json(result)) +
        `<div class="fd-row">${linkButton('Back to the console', '/admin', { variant: 'outline' })}</div>`, { description: 'The change is saved.' });
}
// A form the server refused. `back` is the page it was posted from; the browser's own Back keeps what was typed.
export function failedPage(message, status, back, section) {
    const response = adminPage('Not saved', callout('Nothing was changed', message, { tone: 'danger' }) +
        `<p class="fd-muted">Go back in your browser to keep what you entered, fix it, and save again.</p><div class="fd-row">${linkButton('Back to the form', back, { variant: 'outline', icon: 'arrow-left' })}</div>`,
    { description: 'The server refused this change.', active: section });
    return new Response(response.body, { status, headers: response.headers });
}
