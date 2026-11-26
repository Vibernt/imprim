import { html } from 'lit';
import { icon } from '../../lib/icon';
import { href } from '../../lib/router';
import { AdminScreen, corePage } from './core-screen';
import { listCount } from './list-view';
import { cap, clientPath, link, mono, status, table } from './core-view';
import { methodLabel } from './sign-in-methods';
import type { Client } from './client/model';

class ClientsScreen extends AdminScreen<{ clients: Client[] }> {
  protected requestPath() { return '/admin/api/clients?include_drafts=1'; }

  protected override render() {
    const content = this.content(({ clients }) => html`<div class="fd-stack" data-gap="3">
      ${listCount(clients.length, 'client', 'clients')}
      ${table('Clients', ['App', 'Client ID', 'Sign-in methods', 'Sign-up', 'Agents'], clients.map(client => [
        html`${link(clientPath(client.id), client.branding.name || client.id)}${client.draft ? html` <span class="fd-badge">Draft</span>` : ''}${client.branding.name && client.branding.name !== client.id
          ? html`<div class="fd-table-sub" data-stack-only>${mono(client.id)}</div>` : ''}`, mono(client.id),
        html`<div class="fd-row" data-wrap data-gap="1">${client.sign_in_methods.map(method =>
          html`<span class="fd-badge">${methodLabel(method)}</span>`)}</div>`,
        cap(client.signup_policy), client.agent_access === 'on' ? status('on', 'success') : status('off'),
      ]), ['No clients yet', 'Register an app to let people sign in to it here.'], { stackHide: ['Client ID'] })}
    </div>`);
    return corePage('Clients', 'Apps that sign people in through this realm.', content, {
      busy: !this.data && !this.failure,
      actions: html`<a class="fd-btn" data-variant="primary" href=${href('/admin/clients/new')}>${icon('plus')}<span>Register client</span></a>`,
    });
  }
}

customElements.define('screen-admin-clients', ClientsScreen);
