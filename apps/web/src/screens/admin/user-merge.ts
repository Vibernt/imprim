import { html } from 'lit';
import { navigate, type View } from '../../lib/router';
import { AdminScreen, corePage } from './core-screen';
import { card, confirmPhrase, facts, mono, segment, userPath } from './core-view';

type Account = { id: string; email: string };
type Preview = { source: Account; survivor: Account };
const endpoint = (id: string) => '/admin/api/users/' + segment(id) + '/merge';

class UserMerge extends AdminScreen<Preview> {
  protected override requestPath(view: View) { return endpoint(view.params.id) + '?' + view.query; }

  protected override render() {
    const back = { path: userPath(this.view.params.id), label: 'User detail' };
    return corePage(this.data ? 'Merge ' + this.data.source.email + '?' : 'Review merge', 'Check both accounts before you merge.',
      this.content(({ source, survivor }) => html`
        <div class="fd-stack" data-gap="6">
          ${facts([['Deleted', html`${source.email} ${mono(source.id)}`], ['Kept', html`${survivor.email} ${mono(survivor.id)}`]])}
          ${card('This can’t be undone', confirmPhrase({
            id: 'confirm_source_email', phrase: source.email, label: 'Type the deleted user’s email',
            action: 'Merge users', pending: this.pending, cancel: () => { void navigate(back.path); },
            submit: confirm_source_email => {
              void this.write(endpoint(source.id), { surviving_id: survivor.id, confirm_source_email },
                'Users merged', () => { void navigate(userPath(survivor.id), { replace: true }); });
            },
          }), 'The deleted user’s sessions and agent grants end. Their sign-in methods move to the kept user.')}
        </div>`), { back, art: 'orbit', busy: this.pending || (!this.data && !this.failure) });
  }
}

customElements.define('screen-admin-merge', UserMerge);
