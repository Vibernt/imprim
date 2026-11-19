import { html, nothing } from 'lit';
import { api } from '../../../lib/api';
import { navigate } from '../../../lib/router';
import { card } from '../../page-layout';
import { listCount } from '../list-view';
import { AdminRealmScreen } from '../realm-screen';
import { backLink, cap, confirmInline, empty, failed, formData, link, mono, notice, table } from '../realm-ui';
import { adminRoster, realmForm, realmStatus, type Realm, type RealmAdmin } from './forms';

const root = '/admin/realms';
const apiRoot = '/admin/api/realms';
const realmUrl = (realm: string) => root + '?' + new URLSearchParams({ realm });

class RealmsScreen extends AdminRealmScreen<{ realms: Realm[] }> {
  static override properties = { removal: { state: true } };
  declare private removal: { realm: string; admin: RealmAdmin } | undefined;
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

  private saveRealm = async (event: SubmitEvent, realm?: Realm) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.pending) return;
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

  private saveAdmin = async (event: SubmitEvent, realm: Realm, removal?: RealmAdmin) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (this.pending) return;
    const body = removal ? { email: removal.email, role: null } : Object.fromEntries(formData(event));
    this.pending = true;
    try {
      await api(apiRoot + '/' + encodeURIComponent(realm.id) + '/admins', { method: 'POST', body });
      if (!this.isConnected) return;
      this.removal = undefined;
      notice(removal ? 'Administrator removed' : 'Administrator role saved');
      await this.load();
    } catch (error) {
      if (this.isConnected) failed(error);
    } finally {
      this.pending = false;
    }
  };

  protected content({ realms }: { realms: Realm[] }) {
    if (this.creating) return realmForm(undefined, this.pending, this.saveRealm);
    if (!this.selected) return html`<div class="fd-stack" data-gap="3">
      ${listCount(realms.length, 'realm', 'realms')}
      ${table('Realms', ['Realm', 'Issuer', 'Status', 'Admins', 'Actions'], realms.map(realm => [
        html`${link(realmUrl(realm.id), realm.display_name)} ${mono(realm.id)}`, mono(realm.issuer ?? 'Not set'),
        realmStatus(realm.status), realm.admins.map(admin => `${admin.email} (${cap(admin.role)})`).join(', ') || 'None',
        link(realmUrl(realm.id), 'Edit'),
      ]), ['No realms yet', 'Create a realm to add a brand to this deployment.'])}
    </div>`;
    const realm = realms.find(row => row.id === this.selected);
    if (!realm) return empty('Realm not found', 'Return to Realms and choose one from the list.');
    const removal = this.removal?.realm === realm.id ? this.removal.admin : undefined;
    return html`<div class="fd-stack" data-gap="6">
      <p class="fd-muted">${mono(realm.id)}</p>
      ${realmForm(realm, this.pending, event => void this.saveRealm(event, realm))}
      ${adminRoster(realm, this.view.session, this.pending, event => void this.saveAdmin(event, realm),
        admin => { this.removal = { realm: realm.id, admin }; })}
      ${removal ? card('Remove administrator', html`
        ${confirmInline('confirm-admin-removal', removal.email, 'Remove administrator', this.pending,
          event => void this.saveAdmin(event, realm, removal),
          html`<button class="fd-btn" type="button" data-variant="ghost" @click=${() => { this.removal = undefined; }}>Cancel</button>`)}
      `) : nothing}
    </div>`;
  }
}

customElements.define('screen-realms', RealmsScreen);
