import { html } from 'lit';
import { icon } from '../../lib/icon';
import { navigate, type View } from '../../lib/router';
import { AdminScreen, corePage } from './core-screen';
import { link, nextPage, status, table, userPath, when } from './core-view';

import { listCount } from './list-view';
import type { LoadingPreset } from '../loading';

export interface UserSummary {
  id: string; email: string; display_name: string | null; status: string; merged_into: string | null; created: number;
}
const path = '/admin/users';

class UsersScreen extends AdminScreen<{ users: (UserSummary & { last_sign_in: number | null })[]; next: string | null; total: number }> {
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'table', options: { rows: 5, cols: 5 } }];
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
        ${this.content(({ users, next, total }) => html`
          ${listCount(total, 'user', 'users')}
          ${table('Users', ['Email', 'Name', 'Status', 'Last sign-in', 'Created'], users.map(user =>
            [link(userPath(user.id), user.email), user.display_name || '—', status(user.status),
              user.last_sign_in === null ? '—' : when(user.last_sign_in), when(user.created)]),
            search ? ['No users match', 'Try another email or a full user ID.']
              : ['No users yet', 'People appear here after their first sign-in.'])}
          ${nextPage(path, query, next)}
        `)}
      </div>`, { busy: !this.data && !this.failure });
  }
}

customElements.define('screen-admin-users', UsersScreen);
