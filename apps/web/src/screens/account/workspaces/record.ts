import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { focusQuiet } from 'fire-design';
import { ApiError } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import { href, type View } from '../../../lib/router';
import { HeldRows } from '../../held';
import { loading, recordSkeleton } from '../../loading';
import { pageHead } from '../../page-layout';
import { menuTrigger } from '../../row-menu';
import { AccountScreen, post, success } from '../account-screen';
import { confirmAction, inviteForm, renameForm, values } from './forms';
import { invitationTable, memberTable } from './tables';
import { apiRoot, back, kindLabel, memberColumns, memberSegment, notFound, products, readWorkspace, root,
  tableStatus, workspaceTable, type RecordPage } from './view';

type Active = { mode: 'rename' | 'leave'; trigger: string } | { mode: 'role'; sub: string; trigger: string };

const band = (id: string, title: string, body: TemplateResult) => html`
  <section class="fd-band fd-stack" data-pad="sm" data-gap="3" aria-labelledby=${id}>
    <h2 class="fd-h2" id=${id}>${title}</h2>${body}
  </section>`;

class ScreenAccountWorkspace extends AccountScreen<RecordPage | { notFound: true }> {
  protected readonly skeleton = recordSkeleton;
  private readonly holds = new HeldRows(() => this.requestUpdate());
  static override properties = { ...AccountScreen.properties, view: { attribute: false }, active: { state: true }, inviteError: { state: true } };
  declare view: View;
  declare private active: Active | undefined;
  declare private inviteError: string | undefined;

  private get path() { return 'workspaces/' + encodeURIComponent(this.view.params.id); }

  protected read() {
    return readWorkspace<RecordPage>(apiRoot + '/' + encodeURIComponent(this.view.params.id) + '?' + this.view.query);
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    const previous = changed.get('view');
    if (previous && (previous.params.id !== this.view.params.id || previous.query.toString() !== this.view.query.toString())) {
      this.active = undefined;
      this.inviteError = undefined;
      void this.load();
    }
  }

  private async showAction(action: Active) {
    this.active = action;
    await this.updateComplete;
    this.querySelector<HTMLElement>('#im-workspace-active-field')?.focus();
  }

  private cancel = async () => {
    const trigger = this.active?.trigger;
    this.active = undefined;
    await this.updateComplete;
    if (trigger) this.focusTrigger(trigger);
  };

  private focusTrigger(id: string) {
    this.querySelector<HTMLElement>('#' + CSS.escape(id))?.focus();
  }

  private async save(action: string, body: object, title: string) {
    const path = this.path;
    let saved = false;
    await this.mutate(async () => {
      await post(path + '/' + action, body);
      if (!this.isConnected || this.path !== path) return;
      success(title);
      await this.load(false);
      saved = true;
    });
    if (!saved || !this.isConnected || this.path !== path) return;
    await this.cancel();
  }

  private hold(row: string, action: string, title: string, notice: string, email: string, section: string) {
    if (this.pending) return;
    const path = this.path;
    const current = () => this.isConnected && this.path === path;
    if (this.active?.trigger === menuTrigger(row)) this.active = undefined;
    this.holds.start(path + '/' + row, {
      title, description: email, run: send => post(path + '/' + action, {}, send), failed: this.mutationError,
      done: async () => {
        if (!current()) return;
        success(notice);
        await this.load(false);
      },
    }, async () => {
      await this.updateComplete;
      if (current()) this.focusTrigger(menuTrigger(row));
    });
    const heading = this.querySelector<HTMLElement>('#' + section);
    if (heading) focusQuiet(heading);
  }

  private isHeld = (row: string) => this.holds.has(this.path + '/' + row);

  private invite(body: object, form?: HTMLFormElement) {
    const path = this.path;
    void this.mutate(async () => {
      this.inviteError = undefined;
      try {
        await post(path + '/invitations', body);
      } catch (error) {
        if (!(error instanceof ApiError) || !this.isConnected || this.path !== path) throw error;
        if (error.error === 'workspace_invitation_email_failed') await this.load(false);
        if (error.error !== 'no_sign_in_address' && error.error !== 'workspace_invitation_email_failed') throw error;
        this.inviteError = error.description;
        return;
      }
      if (!this.isConnected || this.path !== path) return;
      form?.reset();
      success(t('Invitation sent'));
      await this.load(false);
    });
  }

  private leave = () => {
    const path = this.path;
    void this.mutate(async () => {
      const result = await post<{ workspaces_available: boolean }>(path + '/leave');
      if (this.isConnected && this.path === path) location.replace(href(result.workspaces_available ? root : '/account/apps'));
    });
  };

  private danger(data: RecordPage) {
    const unavailable = data.role === 'owner' && data.workspace.owner_count === 1;
    const button = html`<button class="fd-btn" id="im-workspace-leave" data-variant="danger" type="button"
      ?disabled=${this.pending || unavailable} aria-describedby=${unavailable ? 'im-workspace-leave-reason' : nothing}
      @click=${() => this.showAction({ mode: 'leave', trigger: 'im-workspace-leave' })}>${t('Leave workspace')}</button>`;
    return band('im-workspace-danger', t('Danger zone'), this.active?.mode === 'leave' && !unavailable
      ? confirmAction(data.workspace.name, t('Leave workspace'), this.pending, this.leave, this.cancel)
      : unavailable ? html`<div class="fd-reason">${button}
        <p class="fd-reason-text" id="im-workspace-leave-reason"><i data-icon="lock" aria-hidden="true"></i><span>
          <span class="fd-reason-why">${t('Make someone else an owner first.')}</span></span></p></div>`
      : html`<div class="fd-row">${button}</div>`);
  }

  protected override render() {
    if (this.data && 'notFound' in this.data) return notFound(this.view);
    const data = this.data, owner = data?.role === 'owner', team = data?.workspace.kind === 'team';
    const title = data?.workspace.name ?? t('Workspaces');
    const rename = owner ? html`<button class="fd-btn" id="im-workspace-rename" type="button" data-variant="outline"
      ?disabled=${this.pending} aria-expanded=${this.active?.mode === 'rename'}
      @click=${() => this.showAction({ mode: 'rename', trigger: 'im-workspace-rename' })}>${t('Rename')}</button>` : nothing;
    const busy = this.pending, loadingPage = !data && !this.loadError;
    return html`<main class="fd-page" id="main" tabindex="-1" aria-busy=${busy || loadingPage}><div class="fd-frame">
      ${pageHead(title, data ? kindLabel(data.workspace.kind) : '', back(), rename)}
      ${owner && this.active?.mode === 'rename' && data ? html`<section class="fd-band" data-pad="sm" aria-label=${t('Rename')}>
        ${renameForm(data.workspace.name, busy, event => {
          event.preventDefault();
          void this.save('rename', values(event), t('Name saved'));
        }, this.cancel)}</section>` : nothing}
      ${loadingPage ? html`<section class="fd-band" data-pad="sm">
        ${loading(this.skeleton, { status: t('Loading workspace'), late: t('Still loading. This is taking longer than usual.') })}
      </section>` : band('im-workspace-members', t('Members'), data && !this.loadError ? memberTable(data, this.view.session.sub,
        this.view.query.get('after'), busy, {
          active: this.active?.mode === 'role' ? this.active.sub : undefined,
          choose: (sub, trigger) => { void this.showAction({ mode: 'role', sub, trigger }); },
          cancel: this.cancel,
          save: (sub, body) => { void this.save('members/' + memberSegment(sub) + '/role', body, t('Role saved')); },
          remove: (member, row) => this.hold(row, 'members/' + memberSegment(member.sub) + '/remove',
            t('Removing member'), t('Member removed'), member.email, 'im-workspace-members'),
          isHeld: this.isHeld,
        }) : workspaceTable(t('Members'), memberColumns(),
          tableStatus(3, this.loadError ?? '', () => this.load(), t('The page did not load'))))}
      ${data && !this.loadError ? html`
        ${team && data.invitations ? band('im-workspace-invite', t('Invite someone'), inviteForm(owner, busy, event => {
          event.preventDefault();
          this.invite(values(event), event.currentTarget as HTMLFormElement);
        }, this.inviteError)) : nothing}
        ${team && data.invitations ? band('im-workspace-invitations', t('Open invitations'),
          invitationTable(data.invitations, owner, busy, body => this.invite(body),
            (invite, row) => this.hold(row, 'invitations/' + encodeURIComponent(invite.invitation_id) + '/revoke',
              t('Revoking invitation'), t('Invitation revoked'), invite.email, 'im-workspace-invitations'), this.isHeld)) : nothing}
        ${band('im-workspace-products', t('Products'), products(data.workspace.products))}
        ${team ? this.danger(data) : nothing}
      ` : nothing}
    </div></main>`;
  }
}
customElements.define('screen-account-workspace', ScreenAccountWorkspace);
