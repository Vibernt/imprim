import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { focusQuiet, overlays } from 'fire-design';
import { AdminScreen, corePage } from './core-screen';
import { card, confirmPhrase, mono, segment, status, table } from './core-view';
import { listCount } from './list-view';
import { newService, serviceForm, serviceInput, type Service } from './service-form';

const endpoint = '/admin/api/services';

class ServicesScreen extends AdminScreen<{ services: Service[] }> {
  static override properties = { editing: { state: true }, deleting: { state: true } };
  declare private editing: Service | undefined;
  declare private deleting: Service | undefined;

  protected requestPath() { return endpoint; }

  private close = () => {
    this.editing = undefined;
    this.deleting = undefined;
  };

  private review(service: Service, action: 'edit' | 'delete') {
    if (action === 'edit') this.editing = service;
    else this.deleting = service;
    void this.updateComplete.then(() => {
      if (action === 'delete') this.querySelector<HTMLInputElement>('#confirm-service-delete')?.focus();
      else {
        const heading = this.querySelector<HTMLElement>('#service-editor-title');
        if (heading) focusQuiet(heading);
      }
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

  private deleteService(service: Service) {
    void this.write(endpoint + '/' + segment(service.id) + '/delete', {}, 'Service client deleted', () => {
      this.close();
      return this.reload();
    });
  }

  private listing(services: Service[]) {
    const locked = Boolean(this.editing || this.deleting) || this.pending;
    return html`
      <div class="fd-stack" data-gap="6">
        ${listCount(services.length, 'service client', 'service clients')}
        ${table('Service clients', ['Name', 'Client ID', 'App', 'Scopes', 'Owner', 'Status', 'Actions'],
          services.map(service => [service.name, mono(service.id), mono(service.app_id), service.scopes.join(' '),
            service.owner_email, status(service.status), html`
              <div class="fd-row" data-gap="2">
                <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" ?disabled=${locked}
                  aria-label=${'Edit ' + service.id} @click=${() => this.review(service, 'edit')}>Edit</button>
                <button class="fd-btn" type="button" data-variant="ghost" data-size="sm" ?disabled=${locked}
                  aria-label=${'Delete ' + service.id} @click=${() => this.review(service, 'delete')}>Delete</button>
              </div>`,
          ]), ['No service clients yet', 'Create one to let a service authenticate with its public key.'])}
        ${this.editing ? keyed(this.editing, html`<section class="fd-stack" data-gap="3">
          <h2 class="fd-title" id="service-editor-title">${this.editing.id ? 'Edit service client' : 'Create service client'}</h2>
          ${serviceForm(this.editing, this.pending, this.save, this.close)}
        </section>`) : nothing}
        ${this.deleting ? card('Delete service client?', confirmPhrase({
          id: 'confirm-service-delete', phrase: this.deleting.id, label: 'Type the service client ID', action: 'Delete service client',
          pending: this.pending, cancel: this.close, submit: () => this.deleteService(this.deleting!),
        }), 'The service will no longer be able to sign in with this client.') : nothing}
      </div>`;
  }

  protected override render() {
    return corePage('Service clients', 'Machines acting as themselves for one app, with client credentials and a signed key.',
      this.content(({ services }) => this.listing(services)), {
        busy: this.pending || (!this.data && !this.failure),
        actions: this.data && !this.editing && !this.deleting ? html`
          <button class="fd-btn" type="button" data-variant="primary" @click=${() => this.review(newService, 'edit')}>Create service client</button>` : undefined,
      });
  }
}

customElements.define('screen-admin-services', ServicesScreen);
