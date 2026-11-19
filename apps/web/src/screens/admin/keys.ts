import { html } from 'lit';
import { api } from '../../lib/api';
import { AdminRealmScreen } from './realm-screen';
import { cap, confirmInline, empty, failed, mono, notice, status, table, when } from './realm-ui';

interface Key {
  kid: string;
  alg: string;
  status: 'active' | 'published' | 'retired';
  activates_at: number;
  retired_at: number | null;
}
const root = '/admin/api/keys';
const tone = { active: 'success', published: 'warning', retired: 'neutral' } as const;

class SigningKeysScreen extends AdminRealmScreen<{ keys: Key[] }> {
  static override properties = { selected: { state: true } };
  declare private selected: string | undefined;
  protected heading = 'Signing keys';
  protected override description = 'ES256 and RS256 keys for this realm.';
  protected endpoint() { return root; }

  private change = async (event: SubmitEvent, kid?: string) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.pending) return;
    this.pending = true;
    try {
      await api(kid ? root + '/' + encodeURIComponent(kid) + '/revoke' : root + '/rotate', { method: 'POST', body: {} });
      if (!this.isConnected) return;
      this.selected = undefined;
      notice(kid ? 'Signing key revoked' : 'Signing keys published');
      await this.load();
    } catch (error) {
      if (this.isConnected) failed(error);
    } finally {
      this.pending = false;
    }
  };

  protected content({ keys }: { keys: Key[] }) {
    return html`<div class="fd-stack" data-gap="6">
      ${keys.length ? table('Signing keys', ['Key ID', 'Algorithm', 'Status', 'Signs from', 'Retires'], keys.map(key =>
        [mono(key.kid), mono(key.alg), status(cap(key.status), tone[key.status]), when(key.activates_at), when(key.retired_at)]))
        : empty('No signing keys', 'Keys will appear when they are published.')}
      <section class="fd-stack" data-gap="3">
        <h2 class="fd-h2">Rotate</h2>
        <p class="fd-muted">New keys are published now and start signing in 1 hour. Old public keys stay for 24 hours.</p>
        <form method="post" @submit=${this.change}>
          <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${this.pending}>Rotate now</button>
        </form>
      </section>
      <section class="fd-stack" data-gap="3">
        <h2 class="fd-h2">Emergency revocation</h2>
        <div class="fd-callout" data-tone="warning"><div class="fd-callout-content">
          <p class="fd-callout-title">Only for a compromised key</p>
          <p class="fd-callout-body">The key leaves JWKS at once. Its tokens stop verifying when relying parties refresh their keys.</p>
        </div></div>
        ${this.selected ? confirmInline('confirm-key-id', this.selected, 'Revoke key', this.pending,
          event => void this.change(event, this.selected), html`
            <button class="fd-btn" type="button" data-variant="ghost" @click=${() => { this.selected = undefined; }}>Cancel</button>`)
          : html`<div class="fd-row" data-wrap data-gap="2">${keys.filter(key => key.status !== 'retired').map(key => html`
            <button class="fd-btn" type="button" data-variant="outline" ?disabled=${this.pending} @click=${() => { this.selected = key.kid; }}>
              Revoke ${key.kid}
            </button>`)}</div>`}
      </section>
    </div>`;
  }
}

customElements.define('screen-signing-keys', SigningKeysScreen);
