import { brandingFor } from '../branding/tokens.mjs';
import { t, tHtml } from '../i18n/index.mjs';
import { page } from './layout.mjs';
import { accountLine, button, escapeHtml, heading, hidden, list } from './ui.mjs';

export function workspaceAccessPage(env, { row, client }, email, csrf, workspaces) {
    const brand = brandingFor(env, client), app = brand.name || client.id;
    const title = workspaces.length === 1 ? t(env, '{app} isn’t in your workspace yet', { app })
        : t(env, '{app} isn’t in your workspaces yet', { app });
    const rows = workspaces.slice(0, 5).map(({ name, role }) => {
        const manages = role === 'owner' || role === 'admin';
        const desc = manages
            ? tHtml(env, 'Contact {app} to add it to {workspace}.', {
                app: brand.support_url ? { html: `<a class="fd-link" href="${escapeHtml(brand.support_url)}">${escapeHtml(app)}</a>` } : app,
                workspace: name
            })
            : tHtml(env, 'Ask an owner or admin of {workspace} to add {app}.', { workspace: name, app });
        return { title: name, desc };
    });
    return page(title, heading(title) + accountLine(env, email, { id: row.id, csrf }) +
        (rows.length === 1 ? `<p class="fd-body">${rows[0].desc}</p>` : list(t(env, 'Workspaces'), rows, { divided: true })) +
        `<form method="post" action="/workspace-access">${hidden('request_id', row.id)}${hidden('csrf', csrf)}
        ${button(t(env, 'Back to {app}', { app }), { variant: 'primary', size: 'lg', block: true, truncate: true })}</form>`,
        { client, formTargets: [row.redirect_uri] });
}
