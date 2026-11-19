import { html, nothing, type PropertyValues } from 'lit';
import { navigate, type View } from '../../lib/router';
import { codeBlock, fieldWithAction, setting } from '../page-layout';
import { text } from './core-fields';
import { AdminScreen, corePage } from './core-screen';
import { card, confirmPhrase, empty, facts, mono, segment, status } from './core-view';
import type { UserSummary } from './users';

type SessionRow = { sid: string; method: string; auth_time: number; expires_at: number };
interface User extends UserSummary { sessions: SessionRow[] }
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

class UserDetail extends AdminScreen<User> {
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

  private act(user: User, action: Action, body: object = {}) {
    void this.write(apiPath(user.id) + '/' + action, body, success[action], () => {
      this.review = undefined;
      return this.reload();
    });
  }

  private setReview = (review: Review) => {
    this.review = review;
    void this.updateComplete.then(() => this.querySelector<HTMLInputElement>('#confirm-user-action')?.focus());
  };

  private confirm(user: User, review: Review) {
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

  private sessions(user: User) {
    return user.sessions.length ? html`
      <div role="group" aria-label="Sessions">
        ${user.sessions.map(session => setting(session.method || 'Session', mono(session.sid), html`
          <button class="fd-btn" type="button" data-variant="ghost" data-size="sm"
            aria-label=${'Revoke session ' + session.sid} ?disabled=${this.pending || Boolean(this.review)}
            @click=${() => this.setReview({ action: 'revoke-session', sid: session.sid })}>Revoke</button>`))}
      </div>` : empty('No active sessions.', 'Signed-in sessions appear here.');
  }

  private reviewButton(action: Review['action']) {
    return html`<button class="fd-btn" data-variant="outline" type="button" ?disabled=${this.pending || Boolean(this.review)}
      @click=${() => this.setReview({ action })}>${labels[action]}</button>`;
  }

  private merge(user: User, event: SubmitEvent) {
    event.preventDefault();
    const survivor = new FormData(event.currentTarget as HTMLFormElement).get('surviving_id') as string;
    void navigate('/admin/users/' + segment(user.id) + '/merge?' + new URLSearchParams({ surviving_id: survivor }));
  }

  private details(user: User) {
    const review = this.review;
    return html`
      <div class="fd-stack" data-gap="6">
        ${facts([['User ID', mono(user.id)], ['Status', status(user.status)]])}
        ${card('Sessions', this.sessions(user))}
        ${card('Record', codeBlock('User record', user))}
        ${card('Two-factor', setting('Verification methods', '', this.reviewButton('reset-mfa'), true),
          'Removes authenticators and passkeys so the person can enrol again.')}
        ${card('Merge into another user', html`
          <form class="fd-form" method="get" @submit=${(event: SubmitEvent) => this.merge(user, event)}>
            ${fieldWithAction('surviving_id', 'Surviving user ID', undefined, html`
              <input class="fd-input fd-grow" id="surviving_id" name="surviving_id" data-mono required autocomplete="off" spellcheck="false">`, html`
              <button class="fd-btn" type="submit" data-variant="outline" ?disabled=${this.pending || Boolean(review)}>Review merge</button>`)}
          </form>`, 'This user is deleted. The other user keeps their ID, apps and sign-in methods.')}
        ${card('Account', html`
          ${user.status === 'blocked' ? setting('Sign-in is blocked', '', html`
            <button class="fd-btn" type="button" data-variant="outline" ?disabled=${this.pending || Boolean(review)}
              @click=${() => this.act(user, 'unblock')}>Unblock user</button>`)
            : setting('Block sign-in', '', this.reviewButton('block'), true)}
          ${setting('Permanently delete this user', '', this.reviewButton('delete'), true)}
        `, 'Blocking and deleting end every session and agent grant.')}
        ${review ? card(labels[review.action] + '?', this.confirm(user, review),
          review.sid ? 'This ends session ' + review.sid + '.' : undefined) : nothing}
      </div>`;
  }

  protected override render() {
    return corePage(this.data?.email ?? 'User detail', 'Sessions, status and sign-in methods.',
      this.content(user => this.details(user)), { back, busy: this.pending || (!this.data && !this.failure) });
  }
}

customElements.define('screen-admin-user', UserDetail);
