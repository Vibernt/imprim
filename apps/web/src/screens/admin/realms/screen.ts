import { html, nothing, type PropertyValues } from 'lit';
import { api } from '../../../lib/api';
import { navigate, type View } from '../../../lib/router';
import type { LoadingPreset } from '../../loading';
import { RowConfirmations } from '../../row-confirmations';
import { listCount } from '../list-view';
import { AdminRealmScreen } from '../realm-screen';
import { backLink, cap, empty, failed, formData, link, mono, notice, table } from '../realm-ui';
import { adminRoster, adminRowId, realmForm, realmStatus, type Realm, type RealmAdmin } from './forms';

const root = '/admin/realms';
const apiRoot = '/admin/api/realms';
const realmUrl = (realm: string) => root + '?' + new URLSearchParams({ realm });
const adminsPath = (realm: Realm) => apiRoot + '/' + encodeURIComponent(realm.id) + '/admins';

class RealmsScreen extends AdminRealmScreen<{ realms: Realm[] }> {
  private readonly confirmation = new RowConfirmations(this, () => 'The request could not be completed.');
  private get locked() { return this.pending || this.confirmation.pending; }
  protected get skeleton(): readonly LoadingPreset[] {
    return this.creating || this.selected ? [{ name: 'form', options: { count: 5 } }] :
      [{ name: 'table', options: { rows: 5, cols: 4 } }];
  }

  private get creating() { return this.view.query.get('create') === '1'; }
  private get selected() { return this.view.query.get('realm'); }
  protected get heading() { return this.creating ? 'Create realm' : this.selected ? 'Edit realm' : 'Realms'; }
  protected override get description() {
    if (this.creating) return 'Add an issuer and brand to this deployment.';
    if (this.selected) return 'Manage the issuer, configuration and administrators.';
    return 'Issuers and brands in this deployment.';
  }
  protected endpoint() { return apiRoot; }
  protected override back() { return this.creating || this.selected ? backLink(root, 'Realms') : nothing; }
  protected override actions() {
    return this.data && !this.creating && !this.selected ? html`<a class="fd-btn" data-variant="primary" href=${root + '?create=1'}>Create realm</a>` : nothing;
  }

  protected override willUpdate(changed: PropertyValues) {
    const previous = changed.get('view') as View | undefined;
    if (previous && previous.query.toString() !== this.view.query.toString()) this.confirmation.clear();
    super.willUpdate(changed);
  }

  private saveRealm = async (event: SubmitEvent, realm?: Realm) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.locked) return;
    this.confirmation.clear();
    const data = formData(event);
    this.pending = true;
    try {
      const body = { ...Object.fromEntries(data), version: realm?.version, config: JSON.parse(String(data.get('config'))) };
      const result = await api<{ realm: Realm }>(realm ? apiRoot + '/' + encodeURIComponent(realm.id) : apiRoot, { method: 'POST', body });
      if (!this.isConnected) return;
      notice(realm ? 'Realm saved' : 'Realm created');
      if (realm) await this.load();
      else await navigate(realmUrl(result.realm.id));
    } catch (error) {
      if (this.isConnected) failed(error);
    } finally {
      this.pending = false;
    }
  };

  private saveAdmin = async (event: SubmitEvent, realm: Realm) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.locked) return;
    this.confirmation.clear();
    const body = Object.fromEntries(formData(event));
    this.pending = true;
    try {
      await api(adminsPath(realm), { method: 'POST', body });
      if (!this.isConnected) return;
      notice('Administrator role saved');
      await this.load();
    } catch (error) {
      if (this.isConnected) failed(error);
    } finally {
      this.pending = false;
    }
  };

  private removalQuestion(realm: Realm, admin: RealmAdmin) {
    return this.confirmation.view({
      id: adminRowId(realm, admin), table: true,
      text: `Remove administrator access for ${admin.email}?`, action: 'Remove administrator',
      request: () => api(adminsPath(realm), { method: 'POST', body: { email: admin.email, role: null } }),
      done: async () => {
        notice('Administrator removed');
        await this.load(false);
      },
    });
  }

  protected content({ realms }: { realms: Realm[] }) {
    if (this.creating) return realmForm(undefined, this.pending, this.saveRealm);
    if (!this.selected) return html`<div class="fd-stack" data-gap="3">
      ${listCount(realms.length, 'realm', 'realms')}
      ${table('Realms', ['Realm', 'Issuer', 'Status', 'Admins'], realms.map(realm => [
        html`${link(realmUrl(realm.id), realm.display_name)} ${mono(realm.id)}`, mono(realm.issuer ?? 'Not set'),
        realmStatus(realm.status), realm.admins.map(admin => `${admin.email} (${cap(admin.role)})`).join(', ') || 'None',
      ]), ['No realms yet', 'Create a realm to add a brand to this deployment.'])}
    </div>`;
    const realm = realms.find(row => row.id === this.selected);
    if (!realm) return empty('Realm not found', 'Return to Realms and choose one from the list.');
    return html`<div class="fd-stack" data-gap="6">
      <p class="fd-muted">${mono(realm.id)}</p>
      ${realmForm(realm, this.locked, event => void this.saveRealm(event, realm))}
      ${adminRoster(realm, this.view.session, this.locked, event => void this.saveAdmin(event, realm),
        admin => this.removalQuestion(realm, admin))}
    </div>`;
  }
}

customElements.define('screen-realms', RealmsScreen);
