import { collectClientBranding } from './branding-fields';
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
  branding: ClientBranding;
  listed: boolean;
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
  agent_workspace_resources: string[];
  agent_max_grant_days: number;
}

export interface ClientBranding {
  name?: string;
  summary?: string;
  locale_copy?: Record<string, Record<string, string>>;
}

export interface Client extends ClientFields {
  confidential: boolean;
  draft?: true;
  version: number;
}

export interface Delivery {
  counts: { undelivered: number; expired: number };
  events: { id: string; kind: string; created: number; delivery_state: string; last_error: string | null }[];
}

export const SWITCHES = {
  dev: ['1', 0], agent_access: ['on', 'off'], user_events: ['on', 'off'],
  classic_oidc: ['on', 'off'], personal_workspaces: ['on', 'off'], workspace_admin: ['on', 'off'],
  self_signup: ['on', 'off'], join_workspaces: ['on', 'off'],
} as const;
const lists = ['redirect_uris', 'post_logout_uris', 'allowed_domains', 'google_hosted_domains'] as const;

export const exchangePairs = (value: ClientFields) => Object.fromEntries(
  Object.entries(value.token_exchange_from).map(([id, scopes]) => [id, scopes.join(' ')]),
);

export function registrationInput(form: HTMLFormElement, defaults: ClientFields) {
  const data = new FormData(form);
  return {
    id: data.get('id'),
    branding: { name: String(data.get('display_name') ?? '').trim() },
    redirect_uris: fireValue(form, 'redirect_uris', defaults.redirect_uris),
    sign_in_methods: data.getAll('sign_in_methods'),
  };
}

export interface ClientControls {
  shared: boolean;
  agents: boolean;
  selfSignup: boolean;
  invited: boolean;
  email: boolean;
  backchannel: boolean;
  product: boolean;
  classic: boolean;
}

export const initialControls = (client: ClientFields): ClientControls => ({
  shared: client.workspaces === 'shared', agents: client.agent_access === 'on', selfSignup: client.self_signup === 'on',
  invited: client.signup_policy === 'invited', email: client.sign_in_methods.includes('email'),
  backchannel: Boolean(client.backchannel_uri), product: Boolean(client.product), classic: client.classic_oidc === 'on',
});

export function readControls(form: HTMLFormElement): ClientControls {
  const data = new FormData(form);
  return {
    shared: data.get('workspaces') === 'shared', agents: data.has('agent_access'), selfSignup: data.has('self_signup'),
    invited: data.get('signup_policy') === 'invited', email: data.getAll('sign_in_methods').includes('email'),
    backchannel: Boolean(String(data.get('backchannel_uri') ?? '').trim()), product: Boolean(String(data.get('product') ?? '').trim()),
    classic: data.has('classic_oidc'),
  };
}

export function clientInput(form: HTMLFormElement, current: Client) {
  const data = new FormData(form);
  const { shared, agents } = readControls(form);
  const exchange = fireValue(form, 'token_exchange_from', exchangePairs(current));
  return {
    version: current.version,
    ...Object.fromEntries(lists.map(name => [name, fireValue(form, name, current[name])])),
    ...Object.fromEntries(Object.entries(SWITCHES).map(([name, [on, off]]) => [
      name, data.has(name) ? (name === 'dev' ? 1 : on) : off,
    ])),
    ...(shared ? {} : { personal_workspaces: 'off', workspace_admin: 'off', self_signup: 'off', join_workspaces: 'off' }),
    listed: data.has('listed'),
    backchannel_uri: data.get('backchannel_uri'),
    workspaces: data.get('workspaces'),
    product: shared ? data.get('product') || null : current.product,
    initiate_login_uri: data.get('initiate_login_uri') || null,
    signup_policy: data.get('signup_policy'),
    sign_in_methods: data.getAll('sign_in_methods'),
    mfa: data.get('mfa'),
    mfa_trusted_device_days: Number(data.get('mfa_trusted_device_days')),
    id_token_signed_response_alg: data.get('id_token_signed_response_alg'),
    agent_registration_methods: agents ? data.getAll('agent_registration_methods') : current.agent_registration_methods,
    agent_scope_catalogue: agents ? fireValue(form, 'agent_scope_catalogue', current.agent_scope_catalogue) : current.agent_scope_catalogue,
    agent_allowlist: agents ? fireValue(form, 'agent_allowlist', current.agent_allowlist) : current.agent_allowlist,
    agent_resource_prefixes: agents ? fireValue(form, 'agent_resource_prefixes', current.agent_resource_prefixes) : current.agent_resource_prefixes,
    agent_workspace_resources: shared && agents ? fireValue(form, 'agent_workspace_resources', current.agent_workspace_resources) : [],
    agent_max_grant_days: agents ? Number(data.get('agent_max_grant_days')) : current.agent_max_grant_days,
    agent_token_rate: agents ? Number(data.get('agent_token_rate')) : current.agent_token_rate,
    agent_consent_mfa: agents ? data.has('agent_consent_mfa') ? 'required' : 'off' : current.agent_consent_mfa,
    agent_dpop: agents ? data.has('agent_dpop') ? 'required' : 'optional' : current.agent_dpop,
    token_exchange_from: Object.fromEntries(Object.entries(exchange).map(([id, scopes]) => [id, scopes.split(/[\s,]+/).filter(Boolean)])),
    branding: collectClientBranding(data),
  };
}
