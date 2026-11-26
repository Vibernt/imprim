import { html, nothing, type PropertyValues } from 'lit';
import type { View } from '../../../lib/router';
import { href } from '../../../lib/router';
import { AdminScreen, corePage } from '../core-screen';
import { nextPage } from '../core-view';
import { actionId, confirmationId, path, signupTable, statusFilter, type Decision, type SignupRow } from './view';

interface Page { requests: SignupRow[]; next: string | null }
const endpoint = '/admin/api/signups';

class SignupScreen extends AdminScreen<Page> {
  static override properties = { ...AdminScreen.properties, selection: { state: true } };
  declare private selection: { id: string; action: Decision } | undefined;

  protected requestPath(view: View) { return endpoint + '?' + view.query; }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('view')) this.selection = undefined;
    super.willUpdate(changed);
  }

  private focusControl(id: string) {
    void this.updateComplete.then(() => this.querySelector<HTMLElement>('#' + id)?.focus());
  }

  private select = (id: string, action: Decision) => {
    this.selection = { id, action };
    this.focusControl(confirmationId);
  };

  private cancel = () => {
    const selection = this.selection;
    this.selection = undefined;
    if (selection) this.focusControl(actionId(selection.id, selection.action));
  };

  private decide = (id: string, action: Decision, body: object) => {
    void this.write<{ status: 'approved' | 'declined' }>(
      endpoint + '/' + encodeURIComponent(id) + '/' + action, body,
      result => result.status === 'approved' ? 'Request approved' : 'Request declined',
      async () => {
        this.selection = undefined;
        this.dispatchEvent(new Event('im-signup-decided', { bubbles: true }));
        await this.reload();
      });
  };

  protected override render() {
    const filter = this.view.query.get('status') ?? 'pending';
    const query = new URLSearchParams(this.view.query);
    query.delete('before');
    const first = query.size ? path + '?' + query : path;
    return corePage('Sign-up requests', 'Review requests from people who verified their email.', html`
      <div class="fd-stack" data-gap="3">
        ${statusFilter(filter)}
        ${this.content(({ requests, next }) => html`
          ${signupTable(requests, filter, this.selection, this.pending, this.select, this.cancel, this.decide)}
          ${next || this.view.query.has('before') ? html`<div class="fd-row" data-justify="end">
            ${this.view.query.has('before') ? html`<a class="fd-btn" data-variant="ghost" href=${href(first)}>First page</a>` : nothing}
            ${nextPage(path, this.view.query, next)}
          </div>` : nothing}`
        )}
      </div>`, { busy: !this.data && !this.failure });
  }
}

customElements.define('screen-admin-signups', SignupScreen);
