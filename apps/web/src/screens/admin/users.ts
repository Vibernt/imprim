import { html } from 'lit';
import { icon } from '../../lib/icon';
import { navigate, type View } from '../../lib/router';
import { AdminScreen, corePage } from './core-screen';
import { link, mono, nextPage, status, table, userPath } from './core-view';

export interface UserSummary { id: string; email: string; status: string; merged_into: string | null; created: number }
const path = '/admin/users';

class UsersScreen extends AdminScreen<{ users: UserSummary[]; next: string | null }> {
  protected requestPath(view: View) { return '/admin/api/users?' + view.query; }

  private search = (event: SubmitEvent) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget as HTMLFormElement).get('q') as string;
    void navigate(query ? path + '?' + new URLSearchParams({ q: query }) : path);
  };

  protected override render() {
    const query = this.view.query;
    const search = query.get('q') ?? '';
    return corePage('Users', 'Everyone who has signed in to this realm.', html`
      <div class="fd-stack" data-gap="3">
        <form class="fd-toolbar" method="get" @submit=${this.search}>
          <label class="fd-search fd-toolbar-search" data-variant="soft">${icon('search')}
            <input class="fd-search-input" type="search" name="q" aria-label="Email or user ID" placeholder="Email or user ID"
              autocomplete="off" maxlength="254" .value=${search}>
          </label>
          <button class="fd-btn" type="submit">Search</button>
        </form>
        ${this.content(({ users, next }) => html`
          ${table('Users', ['Email', 'Status', 'User ID', 'Actions'], users.map(user =>
            [link(userPath(user.id), user.email), status(user.status), mono(user.id), link(userPath(user.id), 'View')]),
            search ? ['No users match', 'Try another email or a full user ID.']
              : ['No users yet', 'People appear here after their first sign-in.'])}
          ${nextPage(path, query, next)}
        `)}
      </div>`, { busy: !this.data && !this.failure });
  }
}

customElements.define('screen-admin-users', UsersScreen);
