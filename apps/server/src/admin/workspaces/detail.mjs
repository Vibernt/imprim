import { adminPage, cap, card, cards, form, link, when } from '../pages.mjs';
import { actions, attrs, button, callout, code, empty, hidden, kv, linkButton, table, escapeHtml as e } from '../../pages/ui.mjs';
import { FORMS_MODULE } from '../../pages/forms.mjs';
import { workspaceRoles } from '../../workspaces/model.mjs';
import { back, emailField, productField, workspaceName, workspaceStatus } from './pages.mjs';
import { workspacePath } from './read.mjs';

const optionalTable = (title, headings, rows, emptyText) => rows.length ? table(title, headings, rows) : empty('No ' + title.toLowerCase(), emptyText);
function roleField(id, value, canGrantOwner, label = 'Role') {
    const roles = canGrantOwner ? workspaceRoles : workspaceRoles.filter(role => role !== 'owner');
    return `<div class="fd-field"><label class="fd-field-label" for="${e(id)}">${e(label)}</label>
        <select class="fd-select" id="${e(id)}" name="role">${roles.map(role =>
            `<option${attrs({ value: role, selected: role === value })}>${e(cap(role))}</option>`).join('')}</select></div>`;
}

function memberCard(workspace, post, editable, isOwner) {
    const ownerCount = workspace.members.filter(member => member.role === 'owner').length;
    const rows = workspace.members.map((member, index) => {
        const canEdit = editable && workspace.kind === 'team' && (member.role !== 'owner' || (isOwner && ownerCount > 1));
        const target = hidden('sub', member.id);
        const controls = canEdit ? post('role', target + roleField('member-role-' + index, member.role, isOwner, 'Role for ' + member.email) +
            button('Save role', { variant: 'outline', size: 'sm' })) +
            post('remove-member', target + button('Remove member', { variant: 'danger', size: 'sm', 'aria-label': 'Remove ' + member.email })) : '';
        return [e(member.email), e(cap(member.role)), ...(editable && workspace.kind === 'team' ? [controls] : [])];
    });
    const columns = ['Email', 'Role', ...(editable && workspace.kind === 'team' ? ['Actions'] : [])];
    return card(optionalTable('Members', columns, rows, 'Members appear after accepting an invitation.'), 'Members');
}

function invitationCard(workspace, post, editable, isOwner) {
    const rows = workspace.invitations.map(invitation => [
        e(invitation.email), e(cap(invitation.role)), e(when(invitation.expires_at)), ...(editable ? [
            post('revoke-invitation', hidden('invitation_id', invitation.id) + button('Revoke', { variant: 'outline', size: 'sm', 'aria-label': 'Revoke invitation for ' + invitation.email }))
        ] : [])
    ]);
    const columns = ['Email', 'Role', 'Expires', ...(editable ? ['Actions'] : [])];
    return card(optionalTable('Open invitations', columns, rows, 'Invitations appear here until they are accepted, revoked or expire.') +
        (editable && workspace.kind === 'team' ? post('invite', emailField('email', 'Email') + roleField('invitation-role', 'member', isOwner) +
            `<div class="fd-row">${button('Send invitation', { variant: 'outline' })}</div>`) : ''), 'Open invitations');
}

export function detailPage(workspace, csrf, admin) {
    const path = workspacePath(workspace.id);
    const post = (action, body) => form(path + '/' + action, csrf, body);
    const editable = workspace.status === 'active', isOwner = workspace.members.some(member => member.id === admin.user_id && member.role === 'owner');
    const products = workspace.products.length ? workspace.products.map(code).join(', ') : 'None';
    const summary = kv([['Workspace ID', code(workspace.id)], ['Kind', e(cap(workspace.kind))], ['Status', workspaceStatus(workspace.status)], ['Products', products]]);
    const configuration = editable ? cards(
        card(post('rename', workspaceName(workspace.name) + `<div class="fd-row">${button('Save name', { variant: 'outline' })}</div>`), 'Name'),
        card(post('products', productField('add', 'Add products') + productField('remove', 'Remove products') +
            `<div class="fd-row">${button('Save products', { variant: 'outline' })}</div>`), 'Edit products')) : '';
    const resources = workspace.resources.map(row => [code(row.resource), code(row.client_id)]);
    const holds = workspace.holds.map(row => [code(row.client_id), e(row.reason)]);
    const audit = workspace.audit.map(row => [code(row.event), row.actor ? code(row.actor) : 'None', e(when(row.created))]);
    const auditLink = link('/admin/audit?' + new URLSearchParams({ target: workspace.id }), 'View audit log');
    const close = editable ? card(workspace.holds.length ? callout('Workspace is held', 'Apps must release their holds before you can close this workspace.') :
        linkButton('Review closure', path + '/close', { variant: 'outline' }), 'Close workspace') : '';
    return adminPage(workspace.name, [summary, configuration, memberCard(workspace, post, editable, isOwner),
        invitationCard(workspace, post, editable, isOwner), cards(
            card(optionalTable('Registered resources', ['Resource', 'Client ID'], resources, 'Registered app resources appear here.'), 'Registered resources'),
            card(optionalTable('Holds', ['Client ID', 'Reason'], holds, 'Holds from apps appear here.'), 'Holds')),
        card(optionalTable('Audit events', ['Event', 'Actor', 'Time'], audit, 'Workspace changes appear here.') + auditLink, 'Recent audit'), close],
    { active: 'workspaces', back, modules: editable ? [FORMS_MODULE] : [] });
}

export function closePage(workspace, csrf) {
    const path = workspacePath(workspace.id);
    return adminPage('Close workspace', card(callout(workspace.name, 'Closing permanently ends access granted through this workspace.', { tone: 'warning' }) +
        form(path + '/close', csrf, actions(linkButton('Cancel', path, { variant: 'ghost' }), button('Close workspace', { variant: 'danger' })))),
    { active: 'workspaces', back: [workspace.name, path] });
}
