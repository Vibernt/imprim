export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
    readonly redirecting = false,
    readonly details: Readonly<{ workspace_id?: string }> = {},
  ) {
    super(description);
    this.name = 'ApiError';
  }
}

const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const csrfCookie = '__Host-vi_csrf=';

export interface Send {
  /** Let the request outlive the page: a held action committed on pagehide must still reach the server. */
  keepalive?: boolean;
}

export async function api<T>(path: string, options: { method?: string; body?: object } & Send = {}): Promise<T> {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) throw new TypeError('The API URL must be same-origin.');
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers({ accept: 'application/json' });
  if (unsafe.has(method)) {
    headers.set('content-type', 'application/json');
    const csrf = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(csrfCookie));
    if (csrf) headers.set('x-csrf-token', csrf.slice(csrfCookie.length));
  }

  const response = await fetch(url, {
    method, credentials: 'same-origin', headers, body: JSON.stringify(options.body), keepalive: options.keepalive ?? false,
  });
  if (response.ok) return response.json() as Promise<T>;

  const problem = await response.json().catch(() => null) as { error?: string; error_description?: string; workspace_id?: string } | null;
  const next = encodeURIComponent(location.pathname + location.search);
  const inAdmin = location.pathname.startsWith('/admin');
  const login = (response.status === 401 && problem?.error === 'login_required')
    || (response.status === 403 && problem?.error === 'reauth_required' && inAdmin);
  const mfa = response.status === 403 && problem?.error === 'mfa_required';
  // Only admins can start a sign-in at /login. Account mutations surface the server’s reauthentication
  // instructions, and a signed-out account reload shows how to sign in from an app.
  if (login) {
    if (inAdmin) location.assign(`/login?next=${next}`);
    else location.reload();
  }
  if (mfa) location.assign(`/account/mfa?next=${next}&verify=1`);
  throw new ApiError(response.status, problem?.error ?? 'server_error', problem?.error_description || response.statusText || `HTTP ${response.status}`, login || mfa, { workspace_id: problem?.workspace_id });
}
