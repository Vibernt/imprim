import { html, nothing, type PropertyValues } from 'lit';
import { overlays } from 'fire-design';
import { api } from '../../lib/api';
import type { View } from '../../lib/router';
import { HeldRows } from '../held';
import { recordSkeleton } from '../loading';
import { menuTrigger, rowMenu } from '../row-menu';
import { AdminScreen, corePage } from './core-screen';
import { segment, status, when } from './core-view';
import { recordLayout } from './record-layout';
import { labels, reviewField, userActionsId, userConfirmation, type Review, type UserAction } from './user-actions';
import { linkedIdentities, sessionMenuId, userFacts, userSessions, type UserRecord } from './user-record';

const success: Record<UserAction, string> = {
  block: 'User blocked', unblock: 'User unblocked', delete: 'User deleted', 'reset-mfa': 'Two-step verification reset',
};
const apiPath = (id: string) => '/admin/api/users/' + segment(id);
const back = { path: '/admin/users', label: 'Users' };

class UserDetail extends AdminScreen<UserRecord> {
  protected readonly skeleton = recordSkeleton;
  static override properties = { review: { state: true } };
  declare private review: Review | undefined;
  private readonly holds = new HeldRows(() => this.requestUpdate());

  protected override requestPath(view: View) { return apiPath(view.params.id); }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('view')) {
      const previous = changed.get('view') as View | undefined;
      if (previous?.params.id !== this.view.params.id) this.review = undefined;
    }
    super.willUpdate(changed);
  }

  private focusAfterUpdate(id: string) {
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.focus());
  }

  private act(user: UserRecord, action: UserAction, body: object = {}) {
    void this.write(apiPath(user.id) + '/' + action, body, success[action], () => {
      this.review = undefined;
      return this.reload();
    });
  }

  private select(review?: Review) {
    if (this.pending) return;
    this.review = review;
    this.focusAfterUpdate(review ? reviewField(review) : menuTrigger(userActionsId));
  }

  private revoke(user: UserRecord, session: UserRecord['sessions'][number]) {
    const id = sessionMenuId(session);
    const current = () => this.isConnected && this.view.params.id === user.id;
    this.holds.start(id, {
      title: 'Revoking session',
      description: 'Started ' + when(session.auth_time * 1000),
      run: send => api<{ delivery?: { message?: string } }>(apiPath(user.id) + '/revoke-session', { method: 'POST', body: { sid: session.sid }, ...send }),
      failed: error => { if (current()) this.mutationError(error); },
      done: async result => {
        if (!current()) return;
        overlays.toast({ title: 'Session revoked', description: result.delivery?.message, tone: 'success' });
        await this.reload();
      },
    }, () => { if (current()) this.focusAfterUpdate(menuTrigger(id)); });
  }

  private actions(user: UserRecord) {
    const blocked = user.status === 'blocked';
    return rowMenu(userActionsId, 'More actions for ' + user.email, [
      blocked ? { label: labels.unblock, run: () => this.act(user, 'unblock') }
        : { label: labels.block, run: () => this.select('block') },
      ...(user.verification_methods.length ? [{ label: labels['reset-mfa'], run: () => this.select('reset-mfa') }] : []),
      { label: labels.merge, run: () => this.select('merge') },
      { label: labels.delete, danger: true, run: () => this.select('delete') },
    ], this.pending || user.sessions.some(session => this.holds.has(sessionMenuId(session))) || Boolean(this.review));
  }

  protected override render() {
    const user = this.data;
    return corePage(user?.email ?? 'User detail', user ? 'Created ' + when(user.created) : '',
      this.content(record => recordLayout(html`
        ${this.review ? userConfirmation(record, this.review, this.pending, () => this.select(),
          (action, body) => this.act(record, action, body)) : nothing}
        ${userSessions(record, id => this.holds.has(id), session => this.revoke(record, session), this.pending || Boolean(this.review))}
        ${linkedIdentities(record)}
      `, userFacts(record))), {
        back, busy: this.pending || (!user && !this.failure), actions: user ? this.actions(user) : undefined, pad: user ? 'none' : undefined,
        meta: user ? html`${status(user.status, undefined, 'pill')}
          ${user.verification_methods.length ? status('Two-step verification on', 'success', 'pill') : nothing}` : undefined,
      });
  }
}

customElements.define('screen-admin-user', UserDetail);
