import { html } from 'lit';
import { codeBlock } from '../page-layout';
import { methodLabel } from './sign-in-methods';
import { advanced } from './core-fields';
import { card, empty, mono, table, when } from './core-view';
import { recordFacts } from './record-layout';
import { rowMenu } from '../row-menu';
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

type Session = UserRecord['sessions'][number];
export const sessionMenuId = (session: Session) => 'user-session-' + session.sid;

const verificationLabels: Record<string, string> = {
  totp: 'Authenticator app', passkey: 'Passkey', recovery: 'Recovery codes',
};

export function userFacts(user: UserRecord) {
  return html`
    ${recordFacts([
      ['User ID', user.id, user.id], ['Name', user.display_name || '—'], ['Verified', user.email_verified ? 'Yes' : 'No'],
      ['Locale', user.locale ?? '—'], ['Sign-in methods', user.sign_in_methods.map(methodLabel).join(', ') || 'None'],
      ['Two-step verification', user.verification_methods.map(method => verificationLabels[method] ?? method).join(', ') || 'Off'],
      ['Agent grants', user.agent_grant_count],
    ])}
    ${advanced('Raw record', codeBlock('Raw record', user))}`;
}

export function linkedIdentities(user: UserRecord) {
  return card('Linked identities', user.identities.length ? recordFacts(user.identities.map(identity =>
    [methodLabel(identity.provider), mono(identity.login || identity.provider_id)]))
    : empty('No linked identities', 'Accounts linked through a sign-in provider appear here.'));
}

export function userSessions(user: UserRecord, held: (id: string) => boolean, revoke: (session: Session) => void, disabled: boolean) {
  return card('Sessions', table('Sessions', ['Method', 'Started', 'Expires', 'Actions'], user.sessions.map(session => {
    const id = sessionMenuId(session);
    const busy = held(id);
    const method = methodLabel(session.method);
    const start = when(session.auth_time * 1000);
    return {
      id, busy, cells: [method, start, when(session.expires_at),
        rowMenu(id, `More actions for ${method} session started ${start}`,
          [{ label: 'Revoke', danger: true, run: () => revoke(session) }], disabled || busy)],
    };
  }), ['No sessions', 'Signed-in sessions appear here.'], { emptyOnly: true }));
}
