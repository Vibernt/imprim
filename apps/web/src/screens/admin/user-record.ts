import { html } from 'lit';
import { codeBlock } from '../page-layout';
import { methodLabel } from './sign-in-methods';
import { advanced } from './core-fields';
import { facts, mono, status, when } from './core-view';
import type { UserSummary } from './users';

export interface UserRecord extends UserSummary {
  email_verified: number;
  locale: string | null;
  identities: { provider: string; provider_id: string; login: string | null }[];
  sessions: { sid: string; method: string; auth_time: number; expires_at: number }[];
  sign_in_methods: string[];
  verification_methods: string[];
  agent_grant_count: number;
}

const verificationLabels: Record<string, string> = {
  totp: 'Authenticator app', passkey: 'Passkey', recovery: 'Recovery codes',
};

export const verificationMethods = (user: UserRecord) =>
  user.verification_methods.map(method => verificationLabels[method] ?? method).join(', ') || 'None';

export function userRecord(user: UserRecord) {
  const identities = user.identities.length ? html`<ul class="fd-stack" data-gap="1">
    ${user.identities.map(identity => html`<li>${methodLabel(identity.provider)} · ${mono(identity.login || identity.provider_id)}</li>`)}
  </ul>` : 'None';
  return html`
    ${facts([
      ['Email', user.email], ['Name', user.display_name || '—'], ['Status', status(user.status)],
      ['Verified', user.email_verified ? 'Yes' : 'No'], ['Created', when(user.created)], ['Locale', user.locale ?? '—'],
      ['Sign-in methods', user.sign_in_methods.map(methodLabel).join(', ') || 'None'],
      ['Linked identities', identities], ['Two-step verification', user.verification_methods.length ? 'On' : 'Off'],
      ['Agent grants', user.agent_grant_count], ['User ID', mono(user.id)],
    ])}
    ${advanced('Raw record', codeBlock('Raw record', user))}`;
}
