import { html } from 'lit';
import { choice, fireValue, formSection, jsonField, list, shown, text } from './core-fields';

export interface Service {
  id: string;
  app_id: string;
  name: string;
  owner_email: string;
  jwks: { keys: object[] };
  scopes: string[];
  resource_prefixes: string[];
  status: 'active' | 'disabled';
  source?: 'admin' | 'workspace';
  workspace_name?: string | null;
  accountable_email?: string | null;
  accountable_sub?: string | null;
  expires_at?: number | null;
}

export const newService: Service = {
  id: '', app_id: '', name: '', owner_email: '', jwks: { keys: [] }, scopes: [], resource_prefixes: [], status: 'active',
};

export function serviceInput(form: HTMLFormElement, service: Service) {
  const data = new FormData(form);
  return {
    ...Object.fromEntries(data),
    scopes: fireValue(form, 'scopes', service.scopes),
    resource_prefixes: fireValue(form, 'resource_prefixes', service.resource_prefixes),
    jwks: JSON.parse(String(data.get('jwks'))) as object,
  };
}

export function serviceForm(service: Service, pending: boolean, submit: (event: SubmitEvent) => void, cancel: () => void) {
  return html`
    <form class="fd-form" data-size="full" method="post" data-fd-validate autocomplete="off" ?inert=${pending} @submit=${submit}>
      ${formSection('service-identity', 'Identity', 'The app and owner responsible for this client.',
        service.id ? shown('Service client ID', service.id) : text({
          id: 'service-id', name: 'id', label: 'Service client ID', placeholder: 'notes-worker', mono: true, required: true, pattern: '[a-z0-9][a-z0-9\\-]{2,59}',
        }),
        text({ id: 'service-name', name: 'name', label: 'Name', value: service.name, maxlength: 100, required: true }),
        text({ id: 'service-app', name: 'app_id', label: 'App client ID', value: service.app_id, mono: true, required: true }),
        text({ id: 'service-owner', name: 'owner_email', label: 'Owner email', value: service.owner_email, type: 'email', required: true }),
        choice({ id: 'service-status', name: 'status', label: 'Status', value: service.status, options: [['active', 'Active'], ['disabled', 'Disabled']] }))}
      ${formSection('service-access', 'Keys and access', 'The key, scopes and resources this client can use.',
        jsonField({ id: 'service-jwks', name: 'jwks', label: 'Public JWKS', value: service.jwks, required: true, hint: 'Provide public keys only. Keep private keys in the service.' }),
        list({ id: 'service-scopes', name: 'scopes', label: 'Scopes', values: service.scopes, required: true, hint: 'Use scopes from the app’s catalogue.' }),
        list({ id: 'service-prefixes', name: 'resource_prefixes', label: 'Resource prefixes', values: service.resource_prefixes,
          required: true, pattern: '^https://', hint: 'Use HTTPS prefixes under the app’s resources.' }))}
      <div class="fd-form-actions">
        <button class="fd-btn" type="button" data-variant="ghost" @click=${cancel}>Cancel</button>
        <button class="fd-btn" type="submit" data-variant="primary" ?disabled=${pending}>${service.id ? 'Save service client' : 'Create service client'}</button>
      </div>
    </form>`;
}
