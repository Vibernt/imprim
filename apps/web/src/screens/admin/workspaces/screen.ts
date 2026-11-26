import { html, nothing } from 'lit';
import { api, ApiError } from '../../../lib/api';
import { navigate } from '../../../lib/router';
import { AdminRealmScreen } from '../realm-screen';
import { backLink, failed, formData, mono, notice } from '../realm-ui';
import { closeWorkspace, workspaceDetail } from './detail';
import { createForm } from './forms';
import { workspaceList } from './list';
import { root, workspacePath, type Action, type Submit, type WorkspacePage } from './types';

const apiRoot = '/admin/api/workspaces';
const titles: Record<Action, string> = {
  create: 'Workspace created', rename: 'Name saved', products: 'Products saved', invite: 'Invitation sent',
  'revoke-invitation': 'Invitation revoked', role: 'Role saved', 'remove-member': 'Member removed', close: 'Workspace closed',
};

class WorkspacesScreen extends AdminRealmScreen<WorkspacePage> {
  private get workspaceId() { return this.view.params.id; }
  private get closing() { return this.view.route.path.endsWith('/close'); }
  private get creating() { return !this.workspaceId && this.view.query.get('create') === '1'; }
  private get workspace() { return this.data?.enabled && 'workspace' in this.data ? this.data.workspace : undefined; }

  protected get heading() {
    if (this.data?.enabled === false) return 'Workspaces';
    if (this.closing) return 'Close workspace';
    if (this.creating) return 'Create workspace';
    return this.workspace?.name ?? (this.workspaceId ? 'Workspace' : 'Workspaces');
  }

  protected override get description() {
    if (this.closing) return 'Review the effects of closing this workspace.';
    if (this.creating) return 'Create a team and choose its first owner.';
    return this.workspaceId ? 'Manage membership, products and access.' : 'Teams and personal workspaces in this realm.';
  }

  protected endpoint() {
    if (this.workspaceId) return apiRoot + '/' + encodeURIComponent(this.workspaceId) + (this.closing ? '/close' : '');
    return apiRoot + (this.creating ? '' : '?' + this.view.query);
  }

  protected override back() {
    if (this.data?.enabled === false) return nothing;
    if (this.closing && this.workspace) return backLink(workspacePath(this.workspace.id), this.workspace.name);
    return this.workspaceId || this.creating ? backLink(root, 'Workspaces') : nothing;
  }

  protected override actions() {
    return this.data?.enabled && !this.workspaceId && !this.creating ? html`
      <a class="fd-btn" data-variant="primary" href=${root + '?create=1'}>Create workspace</a>` : nothing;
  }

  private submit: Submit = async (action, event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.pending) return;
    const form = formData(event);
    this.pending = true;
    const endpoint = action === 'create' ? apiRoot : apiRoot + '/' + encodeURIComponent(this.workspaceId) + '/' + action;
    try {
      const body: Record<string, unknown> = action === 'products'
        ? { add: form.getAll('add_product'), remove: form.getAll('remove_product') }
        : Object.fromEntries(form);
      if (action === 'create') body.products = JSON.parse(String(form.get('products')));
      if (action === 'close') body.confirm = String(body.confirm).trim();
      const { workspace_id } = await api<{ workspace_id: string }>(endpoint, { method: 'POST', body });
      if (!this.isConnected) return;
      notice(titles[action]);
      if (action === 'create' || action === 'close') await navigate(workspacePath(workspace_id));
      else await this.load();
    } catch (error) {
      if (!this.isConnected) return;
      const saved = error instanceof ApiError && error.error === 'workspace_invitation_email_failed' && error.details.workspace_id;
      if (saved) {
        notice('Invitation email failed', error instanceof Error ? error.message : undefined, 'danger');
        if (action === 'create') await navigate(workspacePath(saved));
        else await this.load();
      } else failed(error);
    } finally {
      this.pending = false;
    }
  };

  protected content(data: WorkspacePage) {
    if (!data.enabled) return html`<div class="fd-callout"><i class="fd-callout-icon" data-icon="info" aria-hidden="true"></i><div class="fd-callout-content">
      <p class="fd-callout-title">Shared workspaces are off</p>
      <p class="fd-callout-body">Set ${mono('workspaces')} to ${mono('on')} in this realm’s configuration to enable them.</p>
    </div></div>`;
    if ('workspace' in data) return this.closing ? closeWorkspace(data.workspace, this.pending, this.submit)
      : html`${workspaceDetail(data.workspace, this.pending, this.submit)}`;
    if (this.creating) return createForm(this.pending, this.submit);
    return workspaceList(data, this.view.query.get('status') ?? '', this.view.query.get('before'));
  }
}

customElements.define('screen-workspaces', WorkspacesScreen);
