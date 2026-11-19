import { html } from 'lit';
import { icon } from '../../lib/icon';
import { href } from '../../lib/router';
import { AdminScreen, corePage } from './core-screen';
import { cap, clientPath, empty, link, mono, status, table } from './core-view';
import { methodLabel, type Client } from './client/model';

class ClientsScreen extends AdminScreen<{ clients: Client[] }> {
  protected requestPath() { return '/admin/api/clients'; }

  protected override render() {
    const content = this.content(({ clients }) => clients.length
      ? table('Clients', ['App', 'Client ID', 'Sign-in methods', 'Sign-up', 'Agents'], clients.map(client => [
        link(clientPath(client.id), client.branding.name || client.id), mono(client.id),
        html`<div class="fd-row" data-wrap data-gap="1">${client.sign_in_methods.map(method =>
          html`<span class="fd-badge">${methodLabel(method)}</span>`)}</div>`,
        cap(client.signup_policy), client.agent_access === 'on' ? status('on', 'success') : status('off'),
      ]))
      : empty('No clients yet', 'Register an app to let people sign in to it here.'));
    return corePage('Clients', 'Apps that sign people in through this realm.', content, {
      art: 'grid', busy: !this.data && !this.failure,
      actions: html`<a class="fd-btn" data-variant="primary" href=${href('/admin/clients/new')}>${icon('plus')}<span>Register client</span></a>`,
    });
  }
}

customElements.define('screen-admin-clients', ClientsScreen);
