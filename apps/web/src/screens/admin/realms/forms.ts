import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { card } from '../../page-layout';
import { cap, field, formSection, status, table } from '../realm-ui';

export type AdminRole = 'platform' | 'realm';
export interface RealmAdmin { email: string; role: AdminRole }
export interface Realm {
  id: string;
  issuer: string | null;
  display_name: string;
  status: 'active' | 'disabled';
  config: object;
  version: number;
  admins: RealmAdmin[];
}

const configField = (config: object) => html`
  <div class="fd-field">
    <label class="fd-field-label" for="realm-config">Config</label>
    <div class="fd-codefield" data-fd-json>
      <textarea class="fd-codefield-input" id="realm-config" name="config" rows="10" spellcheck="false"
        autocapitalize="off" aria-describedby="realm-config-hint" .value=${JSON.stringify(config, null, 2)}></textarea>
    </div>
    <p class="fd-field-hint" id="realm-config-hint">Name a Worker secret as <code class="fd-code">{"env":"NAME"}</code>.</p>
  </div>`;

export const realmForm = (realm: Realm | undefined, pending: boolean, submit: (event: SubmitEvent) => void) =>
  keyed(realm, html`<form class="fd-form" data-size="full" ?inert=${pending} method="post" @submit=${submit}>
    ${formSection('realm-details', 'Realm details', html`
      ${realm ? nothing : field('realm-id', 'Realm ID', { name: 'id', required: true, max: 40, placeholder: 'acme' })}
      ${field('realm-issuer', 'Issuer', { name: 'issuer', value: realm?.issuer ?? '', type: 'url', required: true, placeholder: 'https://id.acme.com' })}
      ${field('realm-name', 'Display name', { name: 'display_name', value: realm?.display_name, required: true, max: 100, placeholder: 'Acme' })}
      ${realm ? html`<div class="fd-field">
        <label class="fd-field-label" for="realm-status">Status</label>
        <label class="fd-select"><select id="realm-status" name="status">
          <option value="active" ?selected=${realm.status === 'active'}>Active</option>
          <option value="disabled" ?selected=${realm.status === 'disabled'}>Disabled</option>
        </select></label>
      </div>` : nothing}`, realm ? undefined : 'Add the issuer host as a custom domain on this Worker.')}
    ${formSection('realm-configuration', 'Configuration', configField(realm?.config ?? {}))}
    <div class="fd-form-actions"><button class="fd-btn" type="submit" data-variant="primary" ?disabled=${pending}>${realm ? 'Save realm' : 'Create realm'}</button></div>
  </form>`);

export function adminRoster(realm: Realm, viewer: { realm: { id: string }; email: string }, pending: boolean,
  submit: (event: SubmitEvent) => void, remove: (admin: RealmAdmin) => void) {
  return card('Administrators', html`
    ${realm.admins.length ? table('Administrators', ['Email', 'Role', 'Actions'], realm.admins.map(admin => [admin.email, cap(admin.role),
      viewer.realm.id === realm.id && viewer.email === admin.email ? 'Your role' : html`
        <button type="button" class="fd-btn" data-variant="outline" data-size="sm" ?disabled=${pending}
          aria-label=${'Remove administrator ' + admin.email} @click=${() => remove(admin)}>Remove</button>`]))
      : html`<p class="fd-muted">No administrators yet.</p>`}
    <form class="fd-form" method="post" @submit=${submit}>
      <fieldset class="fd-stack" data-gap="3" ?disabled=${pending}>
        <legend class="fd-sr-only">Administrator role</legend>
        ${field('realm-admin-email', 'Administrator email', { name: 'email', type: 'email', max: 254, required: true })}
        <div class="fd-field">
          <label class="fd-field-label" for="realm-admin-role">Administrator role</label>
          <label class="fd-select"><select id="realm-admin-role" name="role"><option value="realm">Realm</option><option value="platform">Platform</option></select></label>
        </div>
        <div><button class="fd-btn" type="submit" data-variant="outline">Save role</button></div>
      </fieldset>
    </form>
  `);
}

export const realmStatus = (value: Realm['status']) => status(cap(value), value === 'active' ? 'success' : 'neutral');
