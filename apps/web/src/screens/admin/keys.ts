import { html, nothing } from 'lit';
import { api } from '../../lib/api';
import { AdminRealmScreen } from './realm-screen';
import { cap, failed, mono, notice, status, table, when } from './realm-ui';
import type { LoadingPreset } from '../loading';
import { rowMenu } from '../row-menu';
import { confirmRowId } from '../confirm-row';
import { RowConfirmations } from '../row-confirmations';

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
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'table', options: { rows: 5, cols: 4 } }];
  private readonly confirmation = new RowConfirmations(this, () => 'The request could not be completed.');
  private get locked() { return this.pending || this.confirmation.pending; }
  protected heading = 'Signing keys';
  protected override get description() { return 'ES256 and RS256 keys for this realm.'; }
  protected endpoint() { return root; }

  private rotate = async (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.locked) return;
    this.confirmation.clear();
    this.pending = true;
    try {
      await api(root + '/rotate', { method: 'POST', body: {} });
      if (!this.isConnected) return;
      notice('Signing keys published');
      await this.load();
    } catch (error) {
      if (this.isConnected) failed(error);
    } finally {
      this.pending = false;
    }
  };

  protected override actions() {
    return this.data ? html`<form method="post" @submit=${this.rotate}>
      <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${this.locked}>Rotate now</button>
    </form>` : nothing;
  }

  private revokeQuestion(key: Key) {
    return this.confirmation.view({
      id: 'key-' + key.kid, table: true, text: `Revoke the ${key.status} ${key.alg} signing key?`,
      action: 'Revoke key',
      phrase: { value: key.kid, label: 'Type the key ID' },
      detail: html`<div class="fd-callout" data-tone="warning" role="note">
        <i class="fd-callout-icon" data-icon="triangle-alert" aria-hidden="true"></i>
        <div class="fd-callout-content">
          <p class="fd-callout-title">Only for a compromised key</p>
          <p class="fd-callout-body">The key leaves JWKS at once. Its tokens stop verifying when relying parties refresh their keys.</p>
        </div>
      </div>`,
      request: () => api(root + '/' + encodeURIComponent(key.kid) + '/revoke', { method: 'POST', body: {} }),
      done: async () => {
        notice('Signing key revoked');
        await this.load(false);
      },
    });
  }

  protected content({ keys }: { keys: Key[] }) {
    return html`<div class="fd-stack" data-gap="4">
      <div class="fd-toolbar"><p class="fd-muted">New keys are published now and start signing in 1 hour. Old public keys stay for 24 hours.</p></div>
      ${table('Signing keys', ['Key ID', 'Algorithm', 'Status', 'Signs from', 'Retires', 'Actions'], keys.map(key => {
        const id = 'key-' + key.kid;
        return { id: key.kid, confirmation: key.status === 'retired' ? undefined : this.revokeQuestion(key),
          cells: [mono(key.kid), mono(key.alg), status(cap(key.status), tone[key.status]), when(key.activates_at), retires(key, keys),
            key.status === 'retired' ? '—' : rowMenu(id, `More actions for ${key.status} ${key.alg} key`,
              [{ label: 'Revoke', danger: true, confirmRow: confirmRowId(id) }], this.locked)] };
      }),
      ['No signing keys', 'Keys will appear when they are published.'])}
    </div>`;
  }
}

customElements.define('screen-signing-keys', SigningKeysScreen);
