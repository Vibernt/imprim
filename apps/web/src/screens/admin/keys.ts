import { html, nothing } from 'lit';
import { api } from '../../lib/api';
import { card } from '../page-layout';
import { AdminRealmScreen } from './realm-screen';
import { cap, confirmInline, failed, mono, notice, status, table, when } from './realm-ui';

interface Key {
  kid: string;
  alg: string;
  status: 'active' | 'published' | 'retired';
  activates_at: number;
  retired_at: number | null;
}
const root = '/admin/api/keys';
function retires(key: Key, keys: Key[]) {
  if (key.retired_at !== null) return when(key.retired_at);
  const replacement = keys.find(other => other.alg === key.alg && other.kid !== key.kid &&
    (key.status === 'retired' ? other.status === 'active' : key.status === 'active' && other.status === 'published'));
  return replacement ? when(replacement.activates_at) : 'At next rotation';
}

const tone = { active: 'success', published: 'warning', retired: 'neutral' } as const;

class SigningKeysScreen extends AdminRealmScreen<{ keys: Key[] }> {
  static override properties = { selected: { state: true } };
  declare private selected: string | undefined;
  protected heading = 'Signing keys';
  protected override get description() { return 'ES256 and RS256 keys for this realm.'; }
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

  protected override actions() {
    return this.data ? html`<form method="post" @submit=${this.change}>
      <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${this.pending}>Rotate now</button>
    </form>` : nothing;
  }

  private select(kid: string) {
    this.selected = kid;
    void this.updateComplete.then(() => this.querySelector<HTMLInputElement>('#confirm-key-id')?.focus());
  }

  protected content({ keys }: { keys: Key[] }) {
    return html`<div class="fd-stack" data-gap="4">
      <div class="fd-toolbar"><p class="fd-muted">New keys are published now and start signing in 1 hour. Old public keys stay for 24 hours.</p></div>
      ${table('Signing keys', ['Key ID', 'Algorithm', 'Status', 'Signs from', 'Retires', 'Actions'], keys.map(key =>
        [html`<code class="fd-code" id=${'key-' + key.kid}>${key.kid}</code>`, mono(key.alg), status(cap(key.status), tone[key.status]), when(key.activates_at), retires(key, keys),
          key.status === 'retired' ? '—' : html`<button class="fd-btn" type="button" data-variant="ghost"
            ?disabled=${this.pending} aria-describedby=${'key-' + key.kid} @click=${() => this.select(key.kid)}>Revoke</button>`]),
      ['No signing keys', 'Keys will appear when they are published.'])}
      ${this.selected ? card('Revoke signing key', html`
        <div class="fd-callout" data-tone="warning">
          <i class="fd-callout-icon" data-icon="triangle-alert" aria-hidden="true"></i>
          <div class="fd-callout-content">
            <p class="fd-callout-title">Only for a compromised key</p>
            <p class="fd-callout-body">The key leaves JWKS at once. Its tokens stop verifying when relying parties refresh their keys.</p>
          </div>
        </div>
        ${confirmInline('confirm-key-id', this.selected, 'Revoke key', this.pending,
          event => void this.change(event, this.selected), html`
            <button class="fd-btn" type="button" data-variant="ghost" @click=${() => { this.selected = undefined; }}>Cancel</button>`)}
      `) : nothing}
    </div>`;
  }
}

customElements.define('screen-signing-keys', SigningKeysScreen);
