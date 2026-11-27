import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { focusQuiet, overlays } from 'fire-design';
import { api } from '../../lib/api';
import { AdminScreen, corePage } from './core-screen';
import { mono, segment, status, table, when } from './core-view';
import { listCount } from './list-view';
import { newService, serviceForm, serviceInput, type Service } from './service-form';
import type { LoadingPreset } from '../loading';
import { rowMenu } from '../row-menu';
import { confirmRowId } from '../confirm-row';
import { RowConfirmations } from '../row-confirmations';

const endpoint = '/admin/api/services';

class ServicesScreen extends AdminScreen<{ services: Service[] }> {
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'table', options: { rows: 5, cols: 4 } }];
  static override properties = { editing: { state: true } };
  declare private editing: Service | undefined;
  private readonly confirmation = new RowConfirmations(this, () => 'The request could not be completed.');

  protected requestPath() { return endpoint; }

  private close = () => {
    this.editing = undefined;
  };

  private edit(service: Service) {
    this.confirmation.clear();
    this.editing = service;
    void this.updateComplete.then(() => {
      const heading = this.querySelector<HTMLElement>('#service-editor-title');
      if (heading) focusQuiet(heading);
    });
  }

  private save = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const service = this.editing;
    if (!service || this.pending) return;
    let body;
    try { body = serviceInput(event.currentTarget as HTMLFormElement, service); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      overlays.toast({ title: 'Check the public JWKS JSON', tone: 'danger' });
      return;
    }
    const path = service.id ? endpoint + '/' + segment(service.id) : endpoint;
    void this.write(path, body, service.id ? 'Service client saved' : 'Service client created', () => {
      this.close();
      return this.reload();
    });
  };

  private removalQuestion(service: Service) {
    const workspace = service.source === 'workspace';
    const verb = workspace ? 'Disable' : 'Delete';
    return this.confirmation.view({
      id: 'service-' + service.id, table: true,
      text: `${verb} ${service.name}? The service can no longer sign in with this client.`,
      action: verb + ' service client', phrase: { value: service.id, label: 'Type the service client ID' },
      request: () => api(endpoint + '/' + segment(service.id) + (workspace ? '' : '/delete'),
        { method: 'POST', body: workspace ? { status: 'disabled' } : {} }),
      done: async () => {
        overlays.toast({ title: workspace ? 'Service client disabled' : 'Service client deleted', tone: 'success' });
        await this.reload();
      },
    });
  }

  private listing(services: Service[]) {
    const locked = Boolean(this.editing) || this.pending || this.confirmation.pending;
    return html`
      <div class="fd-stack" data-gap="6">
        ${services.length ? listCount(services.length, 'service client', 'service clients') : nothing}
        ${table('Service clients', ['Name', 'Client ID', 'App', 'Scopes', 'Owner', 'Workspace', 'Accountable person', 'Expires', 'Status', 'Actions'],
          services.map(service => {
            const id = 'service-' + service.id;
            const canRemove = service.source !== 'workspace' || service.status === 'active';
            const remove = { danger: true, confirmRow: confirmRowId(id) };
            const actions = service.source === 'workspace'
              ? canRemove ? [{ label: 'Disable', ...remove }] : []
              : [{ label: 'Edit', run: () => this.edit(service) }, { label: 'Delete', ...remove }];
            return { id: service.id, confirmation: canRemove ? this.removalQuestion(service) : undefined,
              cells: [service.name, mono(service.id), mono(service.app_id), service.scopes.join(' '),
                service.owner_email, service.workspace_name ?? '', service.accountable_email ?? '', service.expires_at ? when(service.expires_at) : '',
                status(service.status === 'active' && service.expires_at && service.expires_at <= Date.now() ? 'expired' : service.status),
                rowMenu(id, 'More actions for ' + service.name, actions, locked)] };
          }), ['No service clients yet', 'Create one to let a service authenticate with its public key.', !this.editing ? this.createButton() : undefined],
          { emptyOnly: true })}
        ${this.editing ? keyed(this.editing, html`<section class="fd-stack" data-gap="3">
          <h2 class="fd-title" id="service-editor-title">${this.editing.id ? 'Edit service client' : 'Create service client'}</h2>
          ${serviceForm(this.editing, this.pending, this.save, this.close)}
        </section>`) : nothing}
      </div>`;
  }

  private createButton() {
    return html`<div class="fd-row" data-justify="center"><button class="fd-btn" type="button" data-variant="primary"
      ?disabled=${this.confirmation.pending} @click=${() => this.edit(newService)}>Create service client</button></div>`;
  }

  protected override render() {
    return corePage('Service clients', 'Machines acting as themselves for one app, with client credentials and a signed key.',
      this.content(({ services }) => this.listing(services)), {
        busy: this.pending || this.confirmation.pending || (!this.data && !this.failure),
        actions: this.data?.services.length && !this.editing ? this.createButton() : undefined,
      });
  }
}

customElements.define('screen-admin-services', ServicesScreen);
