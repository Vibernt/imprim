import { brandingFor } from '../branding/tokens.mjs';
import { t } from '../i18n/index.mjs';
import { page } from './layout.mjs';
import { accountLine, decisionActions, button, escapeHtml, heading, hidden, list, radio } from './ui.mjs';

export function workspaceJoinPage(env, { client, row }, email, csrf, workspaces) {
    const app = brandingFor(env, client).name || client.id;
    const title = t(env, 'Use a workspace for {app}', { app });
    const consequence = t(env, 'Its members will be able to sign in to {app}.', { app });
    const label = t(env, 'Workspace');
    const single = workspaces.length === 1 ? workspaces[0] : null;
    const usedBy = ({ appNames }) => appNames.length ? t(env, 'Used by {apps}', { apps: appNames.join(', ') }) : '';
    const choices = single
        ? hidden('workspace_id', single.workspace_id) + list(label, [{ title: single.name, desc: escapeHtml(usedBy(single)) }], { divided: true })
        : workspaces.length ? `<div class="fd-stack" data-gap="3" role="radiogroup" aria-label="${escapeHtml(label)}">${workspaces.map(item =>
            radio('workspace_id', item.name, { value: item.workspace_id, required: true, description: usedBy(item) })).join('')}</div>`
        : `<p class="fd-muted">${escapeHtml(t(env, 'No workspaces are available. Go back to the app to start again.'))}</p>`;
    const available = workspaces.length > 0;
    const decline = button(available ? t(env, 'Not now') : t(env, 'Back to {app}', { app }),
        { name: 'action', value: 'decline', variant: available ? 'secondary' : 'primary', size: 'lg', block: true, truncate: true, formnovalidate: true });
    const join = available ? button(single ? t(env, 'Connect {workspace}', { workspace: single.name }) : t(env, 'Connect workspace'),
        { name: 'action', value: 'join', variant: 'primary', size: 'lg', block: true, truncate: true }) : '';
    return page(title, heading(title) + accountLine(env, email, { id: row.id, csrf }) +
        `<form class="fd-stack" data-gap="4" method="post" action="/workspace-join">
${hidden('request_id', row.id)}${hidden('csrf', csrf)}${choices}${available ? `<p class="fd-body">${escapeHtml(consequence)}</p>` : ''}
${join ? decisionActions(join, decline) : decline}</form>`, { client, formTargets: [row.redirect_uri] });
}
