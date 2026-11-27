import { html, nothing, type PropertyValues } from 'lit';
import { ApiError } from '../../../lib/api';
import { navigate } from '../../../lib/router';
import { HeldRows } from '../../held';
import { menuTrigger } from '../../row-menu';
import { AdminRealmScreen } from '../realm-screen';
import { backLink, failed, formData, mono, notice } from '../realm-ui';
import { closeWorkspace, workspaceActions, workspaceDetail } from './detail';
import { createForm } from './forms';
import { workspaceList } from './list';
import { memberRoleId } from './members';
import { kind, workspaceStatus } from './summary';
import { root, workspacePath, type Controls, type Submit, type WorkspacePage } from './types';
import { apiRoot, formBody, titles, writeWorkspace } from './writes';
import { recordSkeleton, type LoadingPreset } from '../../loading';

type Review = { rename: true } | { member: string };
class WorkspacesScreen extends AdminRealmScreen<WorkspacePage> {
  static override properties = { review: { state: true }, invitationError: { state: true } };
  declare private review: Review | undefined;
  declare private invitationError: string | undefined;
  private readonly holds = new HeldRows(() => this.requestUpdate());

  protected get skeleton(): readonly LoadingPreset[] {
    if (this.workspaceId) return recordSkeleton;
    if (this.creating) return [{ name: 'form', options: { count: 4 } }];
    return [{ name: 'table', options: { rows: 5, cols: 4 } }];
  }

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
    if (this.workspace) return kind(this.workspace);
    return this.workspaceId ? '' : 'Teams and personal workspaces in this realm.';
  }

  protected endpoint() {
    if (this.workspaceId) return apiRoot + '/' + encodeURIComponent(this.workspaceId) + (this.closing ? '/close' : '');
    return apiRoot + (this.creating ? '' : '?' + this.view.query);
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('view')) {
      this.review = undefined;
      this.invitationError = undefined;
    }
    super.willUpdate(changed);
  }

  protected override back() {
    if (this.data?.enabled === false) return nothing;
    if (this.closing && this.workspace) return backLink(workspacePath(this.workspace.id), this.workspace.name);
    return this.workspaceId || this.creating ? backLink(root, 'Workspaces') : nothing;
  }

  protected override meta() {
    return this.workspace && !this.closing ? workspaceStatus(this.workspace) : nothing;
  }

  protected override contentPadding() {
    return this.workspace && !this.closing ? 'none' as const : nothing;
  }

  protected override actions() {
    const workspace = this.workspace;
    if (workspace?.editable && !this.closing) {
      return workspaceActions(workspace, this.pending, () => this.select({ rename: true }, 'workspace-name'));
    }
    return this.data?.enabled && !this.workspaceId && !this.creating ? html`
      <a class="fd-btn" data-variant="primary" href=${root + '?create=1'}>Create workspace</a>` : nothing;
  }

  private focusAfterUpdate(id: string) {
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.focus());
  }

  private select(review: Review | undefined, focus: string) {
    this.review = review;
    this.focusAfterUpdate(focus);
  }

  private submit: Submit = async (action, event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.pending) return;
    const form = event.currentTarget as HTMLFormElement;
    const fields = formData(event);
    const current = this.view;
    if (action === 'create' || action === 'invite') this.invitationError = undefined;
    this.pending = true;
    try {
      const { workspace_id } = await writeWorkspace(this.workspaceId, action, formBody(action, fields));
      if (!this.isConnected || this.view !== current) return;
      notice(titles[action]);
      if (action === 'create' || action === 'close') await navigate(workspacePath(workspace_id));
      else {
        if (action === 'rename' || action === 'role') this.review = undefined;
        if (action === 'invite' || action === 'products') form.reset();
        await this.load(false);
      }
    } catch (error) {
      if (!this.isConnected || this.view !== current) return;
      if ((action === 'create' || action === 'invite') && error instanceof ApiError && error.error === 'no_sign_in_address') {
        this.invitationError = error.description;
        return;
      }
      const saved = error instanceof ApiError && error.error === 'workspace_invitation_email_failed' && error.details.workspace_id;
      if (saved) {
        notice('Invitation email failed', error instanceof Error ? error.message : undefined, 'danger');
        if (action === 'create') await navigate(workspacePath(saved));
        else { form.reset(); await this.load(false); }
      } else failed(error);
    } finally {
      this.pending = false;
    }
  };

  private hold: Controls['hold'] = (id, title, action, body, trigger = menuTrigger(id)) => {
    const workspace = this.workspaceId;
    const current = () => this.isConnected && this.workspaceId === workspace && !this.closing;
    this.holds.start(workspace + ':' + id, {
      title, run: send => writeWorkspace(workspace, action, body, send),
      done: async () => {
        if (!current()) return;
        notice(action === 'products' ? 'Product removed' : titles[action]);
        await this.load(false);
      },
      failed: error => { if (current()) failed(error); },
    }, () => { if (current()) this.focusAfterUpdate(trigger); });
  };

  protected content(data: WorkspacePage) {
    if (!data.enabled) return html`<div class="fd-callout"><i class="fd-callout-icon" data-icon="info" aria-hidden="true"></i><div class="fd-callout-content">
      <p class="fd-callout-title">Shared workspaces are off</p>
      <p class="fd-callout-body">Set ${mono('workspaces')} to ${mono('on')} in this realm’s configuration to enable them.</p>
    </div></div>`;
    if ('workspace' in data) return this.closing ? closeWorkspace(data.workspace, this.pending, this.submit)
      : workspaceDetail(data.workspace, {
        pending: this.pending, submit: this.submit, hold: this.hold, renaming: Boolean(this.review && 'rename' in this.review),
        invitationError: this.invitationError,
        role: this.review && 'member' in this.review ? this.review.member : undefined,
        busy: id => this.holds.has(data.workspace.id + ':' + id),
        openRole: member => this.select({ member }, memberRoleId(member)),
        cancel: menu => this.select(undefined, menuTrigger(menu)),
      });
    if (this.creating) return createForm(this.pending, this.submit, this.invitationError);
    return workspaceList(data, this.view.query.get('status') ?? '', this.view.query.get('before'));
  }
}

customElements.define('screen-workspaces', WorkspacesScreen);
