import { adminPage, cap, card, form, link } from '../pages.mjs';
import { button, callout, code, empty, field, linkButton, status, table, escapeHtml as e } from '../../pages/ui.mjs';
import { choice, FORMS_MODULE, list } from '../../pages/forms.mjs';
import { newPath, pageSize, root, workspacePath } from './read.mjs';

export const back = ['Workspaces', root];
export const workspaceStatus = value => status(cap(value), value === 'active' ? 'success' : 'neutral');
export const workspaceName = value => field({ id: 'name', name: 'name', label: 'Workspace name', value, required: true, maxlength: 120 });
export const emailField = (name, label) => field({ id: name, name, label, type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
export const productField = (name, label) => list({ id: name, name, label, placeholder: 'notes', pattern: '^[a-z][a-z0-9-]{1,39}$' });

export function disabledPage() {
    return adminPage('Workspaces', callout('Shared workspaces are off',
        'Set ' + code('workspaces') + ' to ' + code('on') + ' in this realm’s configuration to enable them.'), { active: 'workspaces' });
}

export function listPage(rows, filter) {
    const create = linkButton('Create workspace', newPath, { variant: 'primary', icon: 'plus' });
    const filterForm = `<form class="fd-row" data-align="end" data-gap="2" data-wrap method="get" action="${root}">${choice({
        id: 'status', name: 'status', label: 'Status', value: filter, options: [['', 'All'], ['active', 'Active'], ['closed', 'Closed']]
    })}${button('Apply filter', { variant: 'outline' })}</form>`;
    const body = rows.length ? table('Workspaces', ['Name', 'Kind', 'Status', 'Products', 'Members'], rows.slice(0, pageSize).map(row => [
        link(workspacePath(row.id), row.name), e(cap(row.kind)), workspaceStatus(row.status),
        row.products.length ? row.products.map(code).join(', ') : 'None', e(row.members)
    ])) : filter ? empty('No workspaces match', 'Choose another status.') : empty('No workspaces yet', 'Create a team to share membership across products.');
    const next = rows.length > pageSize ? linkButton('Next page', root + '?' + new URLSearchParams({
        status: filter, before: rows[pageSize - 1].id
    }), { variant: 'ghost' }) : '';
    return adminPage('Workspaces', [{ html: filterForm, pad: 'sm', label: 'Status filter' }, body + next], { active: 'workspaces', actions: create });
}

export function createPage(csrf) {
    return adminPage('Create workspace', card(form(root, csrf, workspaceName() + productField('products', 'Products') +
        emailField('first_owner_email', 'First owner email') + `<div class="fd-row">${button('Create workspace', { variant: 'primary' })}</div>`)),
        { active: 'workspaces', back, modules: [FORMS_MODULE] });
}

export function emailFailurePage(id) {
    const response = adminPage('Invitation email failed', callout('The invitation is saved',
        'Email delivery failed. Check email delivery before inviting this address again.', { tone: 'danger' }) +
        linkButton('View workspace', workspacePath(id), { variant: 'outline' }), { active: 'workspaces' });
    return new Response(response.body, { status: 503, headers: response.headers });
}
