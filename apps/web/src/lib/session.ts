import { api } from './api';

export interface Session {
  readonly sub: string;
  readonly email: string;
  readonly initials: string;
  readonly locale: string;
  readonly admin: 'realm' | 'platform' | null;
  readonly admin_ready: boolean;
  readonly mfa: boolean;
  readonly fresh_until: number;
  readonly realm: { readonly id: string; readonly display_name: string };
}

let viewer: Promise<Session> | undefined;
export const loadSession = (): Promise<Session> => viewer ??= api<Session>('/v1/me');
