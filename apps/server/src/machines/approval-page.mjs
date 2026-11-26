import { cookies, CSRF_COOKIE } from '../auth/session.mjs';
import { formatDate, t } from '../i18n/index.mjs';
import { page } from '../pages/layout.mjs';
import { actions, button, code, escapeHtml, heading, hidden, kv, linkButton, list, result, section, small } from '../pages/ui.mjs';
import { machineExpiry } from './approval-write.mjs';
import { thumbprint } from './dpop.mjs';

export async function machineApprovalPage(request, env, row, app, appName, descriptions, named) {
    const workspace = row.workspace_name, title = t(env, 'Allow a machine to act for {workspace}?', { workspace });
    const resources = JSON.parse(row.resources).map(resource => {
        const name = named.get(resource);
        return { title: name || '', desc: code(resource) };
    });
    const scopes = JSON.parse(row.scopes).map(scope => ({ title: scope, desc: escapeHtml(descriptions[scope]) }));
    const keys = await Promise.all(JSON.parse(row.jwks).keys.map(async key => ({
        title: key.kty === 'EC' ? 'ES256' : 'RS256', desc: code((await thumbprint(key)).slice(0, 24))
    })));
    const date = formatDate(env, machineExpiry(app, Date.now()), { year: 'numeric', month: 'short', day: 'numeric' });
    const form = `<form class="fd-form" method="post" action="/machine-client">${hidden('request_id', row.id)}
        ${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}${actions(
        button(t(env, 'Deny'), { name: 'decision', value: 'deny', variant: 'outline' }),
        button(t(env, 'Approve'), { name: 'decision', value: 'approve', variant: 'primary' }))}</form>`;
    return page(title, heading(title) + kv([[t(env, 'App'), escapeHtml(appName)], [t(env, 'Workspace'), escapeHtml(workspace)],
        [t(env, 'Machine name'), escapeHtml(row.name)]], 1) +
        section(t(env, 'Resources'), '', list(t(env, 'Resources'), resources)) +
        section(t(env, 'Scopes'), '', list(t(env, 'Scopes'), scopes)) +
        section(t(env, 'Public key thumbprints'), '', list(t(env, 'Public key thumbprints'), keys)) +
        small(t(env, 'Works until {date}, unless you or another admin stop it.', { date })) +
        small(t(env, 'You stay accountable for it: it stops if you leave the workspace or stop being an owner or admin.')) +
        form, { size: 'md', client: app });
}

export function machineResultPage(env, approved, app, appName) {
    if (!approved) {
        const title = t(env, 'Request denied.');
        return page(title, result('ban', 'neutral', title), { client: app });
    }
    const title = t(env, 'Machine allowed.');
    const back = t(env, 'Go back to {app}.', { app: appName });
    return page(title, result('circle-check', 'success', title, app.initiate_login_uri ? '' : back) +
        (app.initiate_login_uri ? linkButton(back, app.initiate_login_uri, { variant: 'primary', size: 'lg', block: true }) : ''), { client: app });
}
