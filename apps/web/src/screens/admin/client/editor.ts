import { html, nothing, type PropertyValues } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { overlays } from 'fire-design';
import { href, navigate, type View } from '../../../lib/router';
import { AdminScreen, corePage } from '../core-screen';
import { clientPath, segment } from '../core-view';
import { deliveryPanel, rotationPanel, secretPanel } from './editor-panels';
import { clientInput, type Client, type ClientFields, type Delivery } from './model';
import { clientSections } from './sections';

type Editor = ({ defaults: ClientFields } | (Client & { delivery: Delivery })) & { providers: Record<string, string> };
type Secret = { id: string; value: string };
const clientsApi = '/admin/api/clients';
const back = { path: '/admin/clients', label: 'Clients' };

class ClientEditor extends AdminScreen<Editor> {
  static override properties = { secret: { state: true }, rotating: { state: true }, formRevision: { state: true } };
  declare private secret: Secret | undefined;
  declare private rotating: boolean;
  private formRevision = 0;

  protected override requestPath(view: View) {
    return view.params.id === undefined ? clientsApi + '/editor/defaults' : clientsApi + '/' + segment(view.params.id);
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('view')) {
      const previous = changed.get('view') as View | undefined;
      if (previous?.params.id !== this.view.params.id) {
        this.secret = undefined;
        this.rotating = false;
      }
    }
    super.willUpdate(changed);
  }

  private save = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const data = this.data;
    if (!data || this.pending) return;
    const isNew = 'defaults' in data;
    let body;
    try {
      body = isNew
        ? clientInput(event.currentTarget as HTMLFormElement, data.defaults)
        : clientInput(event.currentTarget as HTMLFormElement, data, data.version);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      overlays.toast({ title: 'Check the branding JSON', tone: 'danger' });
      return;
    }
    void this.write<{ client: Client; client_secret?: string }>(
      isNew ? clientsApi : clientsApi + '/' + segment(data.id), body, isNew ? 'Client registered' : 'Client saved',
      async ({ client, client_secret }) => {
        if (client_secret) this.secret = { id: client.id, value: client_secret };
        if (!isNew) {
          this.data = { ...data, ...client };
          await this.reload();
          this.formRevision++;
        }
      },
    );
  };

  private reviewRotation = (open: boolean) => {
    this.rotating = open;
    if (open) void this.updateComplete.then(() => this.querySelector<HTMLInputElement>('#confirm-client-rotation')?.focus());
  };

  private rotate = (convert: boolean) => {
    const data = this.data;
    if (!data || 'defaults' in data) return;
    void this.write<{ id: string; client_secret: string }>(
      clientsApi + '/' + segment(data.id) + '/rotate-secret',
      { version: data.version, ...(convert ? { make_confidential: true } : {}) }, 'Client secret rotated',
      ({ id, client_secret }) => {
        this.data = { ...data, confidential: true, version: data.version + 1 };
        this.secret = { id, value: client_secret };
        this.rotating = false;
      },
    );
  };

  private dismissSecret = () => {
    const secret = this.secret;
    this.secret = undefined;
    if (secret && this.view.params.id === undefined) void navigate(clientPath(secret.id), { replace: true });
  };

  private editor = (data: Editor) => {
    const isNew = 'defaults' in data;
    return html`
      <div class="fd-stack" data-gap="6">
        ${this.secret ? secretPanel(this.secret.value, this.dismissSecret) : nothing}
        ${!isNew || !this.secret ? keyed(this.formRevision, html`
          <form class="fd-form" data-size="full" method="post" data-fd-validate autocomplete="off"
            ?inert=${this.pending || Boolean(this.secret)} @submit=${this.save}>
            ${clientSections(isNew ? data.defaults : data, isNew, data.providers)}
            <div class="fd-form-actions">
              <a class="fd-btn" data-variant="ghost" href=${href(back.path)}>Cancel</a>
              <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${this.pending || Boolean(this.secret)}>
                ${isNew ? 'Register client' : 'Save client'}
              </button>
            </div>
          </form>`) : nothing}
        ${isNew ? nothing : html`<div class="fd-grid" data-min="lg" data-cols="2" data-gap="6">
          ${this.secret ? nothing : rotationPanel(data, this.rotating, this.pending, this.reviewRotation, this.rotate)}
          ${deliveryPanel(data.delivery)}
        </div>`}
      </div>`;
  };

  protected override render() {
    const isNew = this.view.params.id === undefined;
    const data = this.data;
    const title = isNew ? 'Register client' : data && 'id' in data ? data.branding.name || data.id : 'Edit client';
    return corePage(title, isNew ? 'An app that signs people in through this realm.' : 'Sign-in, callbacks and agent access for this app.',
      this.content(this.editor), { back, art: 'grid', busy: this.pending || (!this.data && !this.failure) });
  }
}

customElements.define('screen-admin-client-editor', ClientEditor);
