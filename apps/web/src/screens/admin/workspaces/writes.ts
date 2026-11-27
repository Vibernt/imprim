import { api, type Send } from '../../../lib/api';
import type { Action } from './types';

export const apiRoot = '/admin/api/workspaces';

export const titles: Record<Action, string> = {
  create: 'Workspace created', rename: 'Name saved', products: 'Products saved', invite: 'Invitation sent',
  'revoke-invitation': 'Invitation revoked', role: 'Role saved', 'remove-member': 'Member removed', close: 'Workspace closed',
};

export function formBody(action: Action, form: FormData) {
  if (action === 'products') return { add: form.getAll('add_product'), remove: [] };
  const body: Record<string, unknown> = Object.fromEntries(form);
  if (action === 'create') body.products = JSON.parse(String(form.get('products')));
  if (action === 'close') body.confirm = String(body.confirm).trim();
  return body;
}

export function writeWorkspace(id: string | undefined, action: Action, body: object, send: Send = {}) {
  const path = action === 'create' ? apiRoot : apiRoot + '/' + encodeURIComponent(id!) + '/' + action;
  return api<{ workspace_id: string }>(path, { method: 'POST', body, ...send });
}
