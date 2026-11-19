import { fireValue } from '../core-fields';

export interface ClientFields {
  id: string;
  redirect_uris: string[];
  post_logout_uris: string[];
  backchannel_uri: string | null;
  signup_policy: string;
  sign_in_methods: string[];
  google_hosted_domains: string[];
  allowed_domains: string[];
  branding: { name?: string };
  dev: number;
  workspaces: string;
  product: string | null;
  personal_workspaces: string;
  workspace_admin: string;
  self_signup: string;
  join_workspaces: string;
  initiate_login_uri: string | null;
  mfa: string;
  mfa_trusted_device_days: number;
  agent_consent_mfa: string;
  agent_dpop: string;
  classic_oidc: string;
  id_token_signed_response_alg: string;
  agent_token_rate: number;
  token_exchange_from: Record<string, string[]>;
  user_events: string;
  agent_access: string;
  agent_registration_methods: string[];
  agent_allowlist: string[];
  agent_scope_catalogue: Record<string, string>;
  agent_resource_prefixes: string[];
  agent_max_grant_days: number;
}

export interface Client extends ClientFields {
  confidential: boolean;
  version: number;
}

export interface Delivery {
  counts: { undelivered: number; expired: number };
  events: { id: string; kind: string; created: number; delivery_state: string; last_error: string | null }[];
}

export const METHODS: Record<string, string> = { email: 'Email link', password: 'Password', passkey: 'Passkey', github: 'GitHub', google: 'Google' };
export const methodLabel = (method: string) => Object.hasOwn(METHODS, method) ? METHODS[method] : method;
export const SWITCHES = {
  dev: ['1', 0], agent_access: ['on', 'off'], user_events: ['on', 'off'], agent_consent_mfa: ['required', 'off'],
  agent_dpop: ['required', 'optional'], classic_oidc: ['on', 'off'], personal_workspaces: ['on', 'off'], workspace_admin: ['on', 'off'],
  self_signup: ['on', 'off'], join_workspaces: ['on', 'off'],
} as const;
const lists = ['redirect_uris', 'post_logout_uris', 'allowed_domains', 'google_hosted_domains', 'agent_allowlist', 'agent_resource_prefixes'] as const;

export const exchangePairs = (value: ClientFields) => Object.fromEntries(
  Object.entries(value.token_exchange_from).map(([id, scopes]) => [id, scopes.join(' ')]),
);

export function clientInput(form: HTMLFormElement, current: ClientFields, version?: number) {
  const data = new FormData(form);
  const exchange = fireValue(form, 'token_exchange_from', exchangePairs(current));
  return {
    ...(version === undefined ? { id: data.get('id') } : { version }),
    ...Object.fromEntries(lists.map(name => [name, fireValue(form, name, current[name])])),
    ...Object.fromEntries(Object.entries(SWITCHES).map(([name, [on, off]]) => [
      name, data.has(name) ? (name === 'dev' ? 1 : on) : off,
    ])),
    backchannel_uri: data.get('backchannel_uri'),
    workspaces: data.get('workspaces'),
    product: data.get('product') || null,
    initiate_login_uri: data.get('initiate_login_uri') || null,
    signup_policy: data.get('signup_policy'),
    sign_in_methods: data.getAll('sign_in_methods'),
    mfa: data.get('mfa'),
    mfa_trusted_device_days: Number(data.get('mfa_trusted_device_days')),
    id_token_signed_response_alg: data.get('id_token_signed_response_alg'),
    agent_registration_methods: data.getAll('agent_registration_methods'),
    agent_scope_catalogue: fireValue(form, 'agent_scope_catalogue', current.agent_scope_catalogue),
    agent_max_grant_days: Number(data.get('agent_max_grant_days')),
    agent_token_rate: Number(data.get('agent_token_rate')),
    token_exchange_from: Object.fromEntries(Object.entries(exchange).map(([id, scopes]) => [id, scopes.split(/[\s,]+/).filter(Boolean)])),
    branding: JSON.parse(String(data.get('branding'))) as object,
  };
}
