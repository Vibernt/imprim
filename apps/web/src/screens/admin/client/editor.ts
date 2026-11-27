import { html, nothing, type PropertyValues } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { overlays } from 'fire-design';
import { href, navigate, type View } from '../../../lib/router';
import { AdminScreen, corePage } from '../core-screen';
import { formSection } from '../core-fields';
import { clientPath, segment } from '../core-view';
import { rotationConfirmation, secretPanel } from './editor-panels';
import { clientInput, initialControls, readControls, registrationInput, type Client, type ClientFields, type ClientControls, type Delivery } from './model';
import { registrationSections } from './registration';
import { clientSections } from './sections';
import type { LoadingPreset } from '../../loading';

type Editor = ({ defaults: ClientFields } | (Client & { delivery?: Delivery })) & { providers: Record<string, string> };
const clientsApi = '/admin/api/clients';
const back = { path: '/admin/clients', label: 'Clients' };

class ClientEditor extends AdminScreen<Editor> {
  protected readonly skeleton: readonly LoadingPreset[] = [{ name: 'form', options: { count: 5 } }];
  protected override inlineSaveErrors = true;
  static override properties = {
    secret: { state: true }, rotating: { state: true }, formRevision: { state: true }, controls: { state: true },
  };
  declare private secret: string | undefined;
  declare private rotating: boolean;
  declare private controls: ClientControls | undefined;
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
        this.controls = undefined;
      }
    }
    super.willUpdate(changed);
  }

  private save = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const data = this.data;
    if (!data || this.pending) return;
    const form = event.currentTarget as HTMLFormElement;
    if ('defaults' in data) {
      void this.write<{ id: string }>(clientsApi + '/editor/drafts', registrationInput(form, data.defaults),
        'Client draft created', async ({ id }) => { await navigate(clientPath(id), { replace: true }); });
      return;
    }
    let body;
    try { body = clientInput(form, data); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      overlays.toast({ title: 'Check the branding JSON', tone: 'danger' });
      return;
    }
    const endpoint = clientsApi + '/' + segment(data.id) + (data.draft ? '/activate' : '');
    void this.write<{ client: Client; client_secret?: string }>(endpoint, body, data.draft ? 'Client activated' : 'Client saved',
      async ({ client, client_secret }) => {
        if (client_secret) this.showSecret(client_secret);
        // Load the saved client before the form is rebuilt: Fire's pairs and tag editors read their value once, when
        // they start, so a form rebuilt from the old data would keep (and on the next save send) the old values.
        this.data = { ...data, ...client, draft: undefined };
        await this.reload();
        this.controls = undefined;
        this.formRevision++;
      });
  };

  private updateControls = (event: Event) => {
    if (this.data && !('defaults' in this.data)) this.controls = readControls(event.currentTarget as HTMLFormElement);
  };

  private reviewRotation = (open: boolean) => {
    this.rotating = open;
    const target = open ? '#confirm-client-rotation' : '#im-review-rotation';
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(target)?.focus());
  };

  private rotate = (convert: boolean) => {
    const data = this.data;
    if (!data || 'defaults' in data || data.draft) return;
    void this.write<{ client_secret: string }>(
      clientsApi + '/' + segment(data.id) + '/rotate-secret',
      { version: data.version, ...(convert ? { make_confidential: true } : {}) }, 'Client secret rotated',
      ({ client_secret }) => {
        this.data = { ...data, confidential: true, version: data.version + 1 };
        this.showSecret(client_secret);
        this.rotating = false;
      },
    );
  };

  private showSecret(secret: string) {
    this.secret = secret;
    void this.updateComplete.then(() => this.querySelector<HTMLButtonElement>('[data-fd-field-action="reveal"]')?.focus());
  }

  private editor = (data: Editor) => {
    const isNew = 'defaults' in data;
    const submit = isNew ? 'Register client' : data.draft ? 'Activate client' : 'Save client';
    return html`<div class="fd-stack" data-gap="4">
      <div class="fd-stack" data-gap="4" ?hidden=${Boolean(this.secret)}>
        ${keyed(this.formRevision, html`
          <form class="fd-form" data-size="full" id="im-client-config" method="post" data-fd-validate autocomplete="off"
            ?inert=${this.pending} @input=${this.updateControls} @change=${this.updateControls} @submit=${this.save}>
            ${isNew ? registrationSections(data.defaults, data.providers) :
              clientSections(data, this.controls ?? initialControls(data), data.providers, data.delivery)}
          </form>`)}
        ${!isNew && !data.draft ? html`<div class="fd-form" data-size="full">
          ${formSection('client-secret', 'Client secret',
            data.confidential ? 'Rotating stops the current secret.' : 'A public client uses PKCE and has no secret.',
            this.rotating ? rotationConfirmation(data, this.pending, () => this.reviewRotation(false), this.rotate) : html`
              <div class="fd-row"><button class="fd-btn" type="button" data-variant="outline" id="im-review-rotation"
                ?disabled=${this.pending} @click=${() => this.reviewRotation(true)}>Review secret rotation</button></div>`)}
        </div>` : nothing}
        ${this.saveErrorNotice()}
        <div class="fd-form-actions" data-variant=${isNew ? nothing : 'sticky'}>
          <a class="fd-btn" data-variant="ghost" href=${href(back.path)}>Cancel</a>
          <button class="fd-btn" type="submit" form="im-client-config" data-variant="primary" ?disabled=${this.pending}>${submit}</button>
        </div>
      </div>
    </div>`;
  };

  protected override render() {
    const isNew = this.view.params.id === undefined;
    const data = this.data;
    const editing = data && 'id' in data ? data : undefined;
    const title = isNew ? 'Register client' : editing?.branding.name || editing?.id || 'Edit client';
    const description = isNew ? 'Create a draft for an app.' : editing?.draft
      ? 'Add a back-channel URL and activate this draft to allow sign-ins.' : 'Manage sign-in, callbacks and agent access.';
    return corePage(title, description, html`
      ${this.secret ? secretPanel(this.secret, () => { this.secret = undefined; }) : nothing}
      ${this.secret && !this.data ? nothing : this.content(this.editor)}
    `, { back, busy: this.pending || (!this.data && !this.failure) });
  }
}

customElements.define('screen-admin-client-editor', ClientEditor);
