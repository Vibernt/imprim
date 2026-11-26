import { brandingFor } from '../branding/tokens.mjs';
import { t } from '../i18n/index.mjs';
import { page } from './layout.mjs';
import { actions, button, escapeHtml, heading, hidden, radio } from './ui.mjs';

export function workspaceJoinPage(env, { client, row }, csrf, workspaces) {
    const app = brandingFor(env, client).name || client.id;
    const title = t(env, 'Use a workspace for {app}', { app });
    const description = t(env, '{app} works with your team’s workspace. Your workspace’s members will be able to sign in to {app}.', { app });
    const label = escapeHtml(t(env, 'Workspace'));
    const options = workspaces.map(({ workspace_id, name, products }) => radio('workspace_id', name, {
        value: workspace_id, checked: workspaces.length === 1, required: true, description: products.join(', ')
    })).join('');
    const choices = options
        ? `<div class="fd-stack" data-gap="3" role="radiogroup" aria-label="${label}">${options}</div>`
        : `<p class="fd-muted">${escapeHtml(t(env, 'No workspaces are available. Go back to the app to start again.'))}</p>`;
    // With nothing to choose, the one way on is back to the app, and the button says so.
    const decline = button(options ? t(env, 'Not now') : t(env, 'Back to {app}', { app }), { name: 'action', value: 'decline', variant: options ? 'outline' : 'primary', formnovalidate: true });
    const join = options ? button(t(env, 'Use this workspace'), { name: 'action', value: 'join', variant: 'primary' }) : '';
    return page(title, heading(title, description) +
        `<form class="fd-stack" data-gap="4" method="post" action="/workspace-join">
${hidden('request_id', row.id)}${hidden('csrf', csrf)}${choices}${actions(decline, join)}</form>`,
    { client, formTargets: [row.redirect_uri] });
}
