import { html, nothing, type PropertyValues } from 'lit';
import { navigate, type View } from '../../lib/router';
import { fieldWithAction, setting } from '../page-layout';
import { text } from './core-fields';
import { AdminScreen, corePage } from './core-screen';
import { card, confirmPhrase, segment, table, when } from './core-view';
import { methodLabel } from './sign-in-methods';
import { userRecord, verificationMethods, type UserRecord } from './user-record';

type Action = 'block' | 'unblock' | 'delete' | 'reset-mfa' | 'revoke-session';
type Review = { action: Exclude<Action, 'unblock'>; sid?: string };
const labels = {
  block: 'Block user', unblock: 'Unblock user', delete: 'Delete user', 'reset-mfa': 'Reset two-factor', 'revoke-session': 'Revoke session',
};
const success = {
  block: 'User blocked', unblock: 'User unblocked', delete: 'User deleted', 'reset-mfa': 'Two-factor reset', 'revoke-session': 'Session revoked',
};
const apiPath = (id: string) => '/admin/api/users/' + segment(id);
const back = { path: '/admin/users', label: 'Users' };

class UserDetail extends AdminScreen<UserRecord> {
  static override properties = { review: { state: true } };
  declare private review: Review | undefined;

  protected override requestPath(view: View) { return apiPath(view.params.id); }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('view')) {
      const previous = changed.get('view') as View | undefined;
      if (previous?.params.id !== this.view.params.id) this.review = undefined;
    }
    super.willUpdate(changed);
  }

  private act(user: UserRecord, action: Action, body: object = {}) {
    void this.write(apiPath(user.id) + '/' + action, body, success[action], () => {
      this.review = undefined;
      return this.reload();
    });
  }

  private setReview = (review: Review) => {
    this.review = review;
    void this.updateComplete.then(() => this.querySelector<HTMLInputElement>('#confirm-user-action')?.focus());
  };

  private confirm(user: UserRecord, review: Review) {
    return confirmPhrase({
      id: 'confirm-user-action', phrase: user.email, label: 'Type the user’s email',
      action: labels[review.action], pending: this.pending, cancel: () => { this.review = undefined; },
      submit: (_, data) => this.act(user, review.action, review.sid === undefined
        ? review.action === 'reset-mfa' ? { reason: data.get('reason') } : {}
        : { sid: review.sid }),
      fields: review.action === 'reset-mfa' ? text({
        id: 'reason', name: 'reason', label: 'Reason', required: true, minlength: 5, maxlength: 500,
        placeholder: 'Lost phone, identity checked by video call', hint: 'Kept in the audit log. The person is told by email.',
      }) : undefined,
    });
  }

  private sessions(user: UserRecord) {
    return table('Sessions', ['Method', 'Started', 'Expires', 'Actions'], user.sessions.map(session => [
      methodLabel(session.method), when(session.auth_time * 1000), when(session.expires_at), html`
        <button class="fd-btn" type="button" data-variant="outline"
          aria-label=${'Revoke session ' + session.sid} ?disabled=${this.pending || Boolean(this.review)}
          @click=${() => this.setReview({ action: 'revoke-session', sid: session.sid })}>Revoke</button>`,
    ]), ['No sessions', 'Signed-in sessions appear here.'], { emptyOnly: true });
  }

  private reviewButton(action: Review['action']) {
    return html`<button class="fd-btn" data-variant="outline" type="button" ?disabled=${this.pending || Boolean(this.review)}
      @click=${() => this.setReview({ action })}>${labels[action]}</button>`;
  }

  private merge(user: UserRecord, event: SubmitEvent) {
    event.preventDefault();
    const survivor = new FormData(event.currentTarget as HTMLFormElement).get('surviving_id') as string;
    void navigate('/admin/users/' + segment(user.id) + '/merge?' + new URLSearchParams({ surviving_id: survivor }));
  }

  private details(user: UserRecord) {
    const review = this.review;
    const confirmation = (action: Review['action']) => review?.action === action
      ? this.confirm(user, review) : nothing;
    return html`
      <div class="fd-stack" data-gap="6">
        ${card('User record', userRecord(user))}
        ${card('Sessions', html`${this.sessions(user)}${confirmation('revoke-session')}`)}
        ${card('Two-step verification', html`
          ${setting('Verification methods', verificationMethods(user), this.reviewButton('reset-mfa'), true)}
          ${confirmation('reset-mfa')}`, 'Reset removes authenticators and passkeys so the person can enrol again.')}
        ${card('Merge into another user', html`
          <form class="fd-form" method="get" @submit=${(event: SubmitEvent) => this.merge(user, event)}>
            ${fieldWithAction('surviving_id', 'Surviving user ID', undefined, html`
              <input class="fd-input fd-grow" id="surviving_id" name="surviving_id" data-mono required autocomplete="off" spellcheck="false">`, html`
              <button class="fd-btn" type="submit" data-variant="outline" ?disabled=${this.pending || Boolean(review)}>Review merge</button>`)}
          </form>`, 'Merging deletes this user.')}
        ${card('Sign-in access', html`
          ${user.status === 'blocked' ? setting('Sign-in is blocked', '', html`
            <button class="fd-btn" type="button" data-variant="outline" ?disabled=${this.pending || Boolean(review)}
              @click=${() => this.act(user, 'unblock')}>Unblock user</button>`)
            : setting('Block sign-in', 'Ends every session and agent grant.', this.reviewButton('block'), true)}
          ${confirmation('block')}
        `)}
        ${card('Delete user', html`
          ${setting('Permanently delete this user', 'Ends every session and agent grant.', this.reviewButton('delete'), true)}
          ${confirmation('delete')}
        `)}
      </div>`;
  }

  protected override render() {
    return corePage(this.data?.email ?? 'User detail', 'Sessions, status and sign-in methods.',
      this.content(user => this.details(user)), { back, busy: this.pending || (!this.data && !this.failure) });
  }
}

customElements.define('screen-admin-user', UserDetail);
