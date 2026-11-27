import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { focusQuiet, overlays } from 'fire-design';
import { api } from '../../../lib/api';
import { href, navigate, type View } from '../../../lib/router';
import { HeldRows } from '../../held';
import { AdminScreen, corePage } from '../core-screen';
import { nextPage } from '../core-view';
import { signupCase } from './case';
import { signupHistory } from './history';
import { signupQueue } from './queue';
import { path, statusFilter, type Decision, type SignupRow } from './view';
import type { LoadingPreset } from '../../loading';

interface Page { requests: SignupRow[]; next: string | null }
interface Result { status: 'approved' | 'declined'; delivery?: { message?: string } }
const endpoint = '/admin/api/signups';

const listSkeleton: readonly LoadingPreset[] = [{ name: 'list', options: { rows: 5 } }];
const tableSkeleton: readonly LoadingPreset[] = [{ name: 'table', options: { rows: 5, cols: 6 } }];
const address = (query: URLSearchParams) => query.size ? path + '?' + query : path;

function pageQuery(view: View) {
  const query = new URLSearchParams(view.query);
  query.delete('request');
  return query;
}

class SignupScreen extends AdminScreen<Page> {
  private readonly holds = new HeldRows(() => this.requestUpdate());
  private readonly reasons = new Map<string, string>();

  private get filter() { return this.view.query.get('status') ?? 'pending'; }
  protected get skeleton() { return this.filter === 'pending' ? listSkeleton : tableSkeleton; }
  protected requestPath(view: View) { return endpoint + '?' + pageQuery(view); }

  private choose = async (id: string | undefined, replace = false) => {
    const query = pageQuery(this.view);
    if (id) query.set('request', id);
    await navigate(address(query), { replace });
    if (!this.isConnected) return;
    const heading = this.querySelector<HTMLElement>('#signup-case-title');
    if (heading && (replace || this.querySelector('.fd-queue-back')?.getClientRects().length)) {
      focusQuiet(heading, { preventScroll: false });
    }
  };

  private decide(row: SignupRow, action: Decision, reason: string, next: string | undefined) {
    if (this.holds.has(row.id)) return;
    const currentPage = this.requestPath(this.view);
    const samePage = () => this.isConnected && this.requestPath(this.view) === currentPage;
    const shell = this.closest('.fd-app');
    this.reasons.set(row.id, reason);
    this.holds.start(row.id, {
      title: action === 'approve' ? 'Creating workspace' : 'Declining request',
      description: row.email,
      seconds: 10,
      // countdownOnly: an approval or a decline is sent only when its 10 seconds run out. Leaving the page (pagehide)
      // or an evicted toast counts as Undo and sends nothing: the safe direction for creating a workspace.
      countdownOnly: true,
      run: send => api<Result>(endpoint + '/' + encodeURIComponent(row.id) + '/' + action,
        { method: 'POST', body: action === 'decline' ? { reason } : {}, ...send }),
      done: async result => {
        this.reasons.delete(row.id);
        if (samePage() && this.data) {
          this.data = { ...this.data, requests: this.data.requests.filter(request => request.id !== row.id) };
        }
        shell?.dispatchEvent(new Event('im-signup-decided', { bubbles: true }));
        overlays.toast({ title: result.status === 'approved' ? 'Request approved' : 'Request declined',
          description: result.delivery?.message, tone: 'success' });
        if (samePage()) await this.reload();
      },
      failed: error => {
        this.mutationError(error);
        if (samePage()) void this.choose(row.id, true);
      },
    }, () => { if (samePage()) void this.choose(row.id, true); });
    void this.choose(next, true);
  }

  private queue(requests: SignupRow[]) {
    const rows = requests.filter(row => !this.holds.has(row.id));
    const requested = this.view.query.get('request');
    const selected = rows.find(row => row.id === requested) ?? rows[0];
    const index = rows.findIndex(row => row === selected);
    const next = rows[index + 1] ?? rows[index - 1];
    const content = selected ? html`${keyed(selected.id, signupCase(selected, this.reasons.get(selected.id) ?? '',
      (action, reason) => this.decide(selected, action, reason, next?.id)))}` : nothing;
    return signupQueue(rows, selected, selected?.id === requested, this.choose, content);
  }

  protected override render() {
    const query = pageQuery(this.view);
    const first = new URLSearchParams(query);
    first.delete('before');
    return corePage('Sign-up requests', 'Review requests from people who verified their email.', html`
      <div class="fd-stack" data-gap="3">
        ${statusFilter(this.filter)}
        ${this.content(({ requests, next }) => html`
          ${this.filter === 'pending' ? this.queue(requests) : signupHistory(requests)}
          ${next || query.has('before') ? html`<div class="fd-row" data-justify="end">
            ${query.has('before') ? html`<a class="fd-btn" data-variant="ghost" href=${href(address(first))}>First page</a>` : nothing}
            ${nextPage(path, query, next)}
          </div>` : nothing}`
        )}
      </div>`, { busy: !this.data && !this.failure });
  }
}

customElements.define('screen-admin-signups', SignupScreen);
