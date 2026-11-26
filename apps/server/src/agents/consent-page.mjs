import { cookies, CSRF_COOKIE } from '../auth/session.mjs';
import { page } from '../pages/layout.mjs';
import { heading, section, button, hidden, callout, kv, code, actions, checkbox, radio, escapeHtml as e } from '../pages/ui.mjs';
import { brandingFor } from '../branding/tokens.mjs';
import { t, tHtml, tPlural, brandCopy, formatDate } from '../i18n/index.mjs';
import { deviceText } from '../lib/device.mjs';
import { workspace } from './uris.mjs';

function replacementOptions(env, grants) {
    if (!grants.length) return '';
    const title = t(env, 'Already connected');
    const options = grants.map((grant, index) => {
        const device = deviceText(grant.approved_device, (id, vars) => t(env, id, vars));
        const place = [device, grant.approved_location].filter(Boolean).join(' · ');
        const date = formatDate(env, grant.created, { month: 'short', day: 'numeric', year: 'numeric' });
        const description = [grant.workspace_name, place && t(env, 'Approved on {device}', { device: place }),
            t(env, 'Connected {date}', { date }), grant.scope].filter(Boolean).join(' · ');
        return radio('replace', grant.label || grant.client_name, { value: grant.id, description, checked: index === 0 });
    });
    options.push(radio('replace', t(env, 'Keep it and add a new connection'), { value: '' }));
    return section(title, '', `<div class="fd-stack" data-gap="2" role="radiogroup" aria-label="${e(title)}">${options.join('')}</div>`);
}

function workspaceOptions(env, workspaces) {
    if (!workspaces) return '';
    const title = t(env, 'Choose a workspace');
    const options = workspaces.map(item => radio('workspace_id', item.name, { value: item.id, checked: workspaces.length === 1,
        required: true, description: item.kind === 'team' ? t(env, 'Team workspace') : t(env, 'Personal workspace') }));
    return section(title, '', `<div class="fd-stack" data-gap="2" role="radiogroup" aria-label="${e(title)}" aria-required="true">${options.join('')}</div>`);
}

// How much the consent screen can say about who is asking (S1, S11):
//   key      - the agent proves its client ID with private_key_jwt at the token endpoint;
//   redirect - the code is delivered only to an HTTPS address the metadata document lists;
//   claimed  - device codes and loopback redirects reach whoever started the flow, so the host is only a claim;
//   none     - dynamically registered: nothing about the name is checked.
export function agentAssurance(row, agent, method) {
    if (method !== 'metadata_document') return 'none';
    if (agent.token_endpoint_auth_method === 'private_key_jwt') return 'key';
    return !row.device_hash && row.redirect_uri?.startsWith('https://') ? 'redirect' : 'claimed';
}
// Shown whenever the code or callback can reach someone other than the person at this screen.
const phishing = env => callout(t(env, 'Only approve your own connection'), t(env, 'Approve only if you started it just now, on this device or your own. If someone sent you this link or code, choose Deny: approving gives them access as you.'), { tone: 'danger' });
export function consentPage(request, env, row, context, { workspaceName, resourceName, workspaces }, choices) {
    const { agent, app, settings, method } = context;
    const assurance = agentAssurance(row, agent, method), name = agent.client_name;
    const host = method === 'metadata_document' ? code(new URL(agent.client_id).host) : '';
    const title = { key: t(env, 'Connect {name}?', { name }), redirect: t(env, 'Connect {name}?', { name }), claimed: t(env, 'Connect an agent calling itself “{name}”?', { name }),
        none: t(env, 'Connect an unverified agent calling itself “{name}”?', { name }) }[assurance];
    // Values are markup: the host is escaped by code(), the rest is escaped text.
    const at = { host: { html: host } }, identity = { key: tHtml(env, '{host}, verified by its signing key', at), redirect: tHtml(env, '{host}, verified by its HTTPS callback', at),
        claimed: tHtml(env, '{host}, <0>claimed, not verified</0>. Any program can use this name.', at, [inner => `<strong>${inner}</strong>`]),
        none: tHtml(env, 'None. This agent registered itself, so its name is not verified.') }[assurance];
    const brand = brandingFor(env, app), intro = brandCopy(env, brand, 'consent_intro'), days = settings.agent_max_grant_days;
    const workspaceValue = workspaces ? e(t(env, 'choose below')) : workspaceName === null ? code(workspace(row.resource)) : e(workspaceName);
    const resourceValue = resourceName ? `${e(resourceName)}<br>${code(row.resource)}` : code(row.resource);
    const scopes = [...choices.scopes].map(([scope, alreadyAllowed]) => {
        const previous = [alreadyAllowed && t(env, 'Already allowed')];
        if (alreadyAllowed && workspaces) previous.push(...new Set(choices.grants
            .filter(grant => grant.scope.split(' ').includes(scope)).map(grant => grant.workspace_name)));
        return checkbox('scope', '', { value: scope, checked: true,
            html: `${code(scope)} ${e(settings.agent_scope_catalogue[scope])}${previous.filter(Boolean).map(label => ` · ${e(label)}`).join('')}` });
    }).join('');
    return page(t(env, 'Connect agent'), heading(title, intro || t(env, 'Approving lets it act as you, within the access below.')) +
        (assurance === 'key' || assurance === 'redirect' ? '' : phishing(env)) +
        kv([[t(env, 'Agent host'), identity], [t(env, 'App'), e(brand.name || app.id)],
            [t(env, 'Workspace'), workspaceValue], [t(env, 'Resource'), resourceValue]], 1) +
        `<form class="fd-form" method="post" action="/agent/consent">${hidden('request_id', row.id)}${hidden('csrf', cookies(request)[CSRF_COOKIE] || '')}
${workspaceOptions(env, workspaces)}
${replacementOptions(env, choices.grants)}
${section(t(env, 'What it can do'), tPlural(env, days, 'Access lasts at most {count} day. The app checks your permissions on every call.', 'Access lasts at most {count} days. The app checks your permissions on every call.'), `<div class="fd-stack" data-gap="2">${scopes}</div>`)}
${actions(button(t(env, 'Deny'), { name: 'decision', value: 'deny', variant: 'outline', formnovalidate: Boolean(workspaces) }), button(t(env, 'Approve'), { name: 'decision', value: 'approve', variant: 'primary' }))}</form>`,
        { size: 'md', client: app, formTargets: row.device_hash || !row.redirect_uri ? [] : [row.redirect_uri] });
}
