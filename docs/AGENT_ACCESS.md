# Agent access

An agent acts for a person, within one app resource. Imprim proves the person and records consent. The app checks workspace membership and role on every call. This guide covers both the app developer and the person connecting an agent. Exact parameters and errors are in [Protocol](PROTOCOL.md).

## App developer: publish a resource

Register an app client first using [Clients](CLIENTS.md). Set `agent_access` to `on`, a nonempty `agent_scope_catalogue`, and a canonical HTTPS `agent_resource_prefixes` entry. Keep prefixes unambiguous across apps. A resource can be a workspace MCP URL such as `https://app.example/w/team-one/mcp`. Imprim checks its registered owner; it does not check that the person belongs to that workspace.

Serve protected resource metadata at the resource's advertised metadata URL. On an unauthenticated MCP request, return 401 with `WWW-Authenticate: Bearer resource_metadata="..."`. The client package provides `protectedResourceMetadata({resource,scopes})` and `wwwAuthenticate({resourceMetadataUrl,error?})`. Metadata names the issuer in `authorization_servers` and the app's supported scopes. Derive the expected audience from the trusted resource route. Call `verifyAccessToken(token,{audience:resource})`, then intersect token scopes with the person's current membership and role. Never derive the expected audience from the token or a caller-controlled parameter.

```js
const resource = 'https://app.example/w/team-one/mcp';
const metadata = client.protectedResourceMetadata({ resource, scopes: ['read'] });
const challenge = client.wwwAuthenticate({ resourceMetadataUrl: 'https://app.example/.well-known/oauth-protected-resource/w/team-one/mcp' });
const claims = await client.verifyAccessToken(token, { audience: resource });
await requireCurrentMembershipAndScope(claims.sub, resource, claims.scope);
```

The app owns `requireCurrentMembershipAndScope`. Imprim does not issue app API tokens. An access JWT is valid for at most 60 seconds, with no positive expiration leeway; revocation delivery also notifies the app. A queued agent revocation event is distinct from OIDC human logout; see [Protocol](PROTOCOL.md).

## Person and agent: connect

1. Give the agent the app's MCP resource URL. The app's 401 challenge points to protected resource metadata; that metadata names Imprim. Imprim exposes `/.well-known/oauth-authorization-server` and OIDC discovery.
2. The agent identifies itself with an HTTPS client ID metadata document, or calls `POST /register` if the app allows `dynamic`. The document must identify its own URL, name and redirect URIs. Dynamic registration returns a public ID without a secret. Registration alone grants no access.
3. The agent requests `response_type=code`, `state`, PKCE S256, scopes and exactly one `resource` at `/authorize`. Agent authorization does not request an ID token. The person signs in through the owning app's enabled method.
4. The consent page shows the agent, app, workspace, resource and grant duration. Choose at least one permission
   to approve. When connecting through a redirect, the page also shows up to five live connections for the same agent,
   app and resource. The newest is selected for replacement. Choose another one, or keep it and add a new connection.
   Permissions from those connections that the app still allows are marked **Already allowed** and can be selected
   too. Replacing a connection revokes its grant and queues the app's revocation event. Device-code consent offers
   the requested permissions and creates a separate connection. Consent is browser-bound, same-origin and CSRF-protected.
5. The agent exchanges the single-use code at `/token` with the exact client, resource, redirect URI and verifier. It saves the returned refresh token securely. Each refresh replaces it. Reusing a spent token revokes the whole grant; serialize refresh requests and persist the replacement atomically.
6. At `/account/agents`, the person can name each connection privately and see its scopes, status, connected and
   last-used times, and the browser and location under **Approved on**. `POST /account/revoke` ends refresh immediately
   and queues a signed app notification when a back-channel URI is configured. Already issued access JWTs expire within 60 seconds.

For a headless agent, `POST /device_authorization` takes `client_id`, `resource` and `scope`. It returns a device secret, an eight-character user code, `/device` verification URLs, a ten-minute expiry and a five-second polling interval. The person enters the code on any browser, signs in and consents. The agent polls `/token` with the device grant and the same client/resource. `authorization_pending` means wait; `slow_down` increases the interval by five seconds; `access_denied` or `expired_token` ends it. Device polling uses its device secret, not PKCE.

## Worked example

Suppose an app has `agent_resource_prefixes: ["https://app.example/w/"]` and `agent_scope_catalogue: {"read":"Read workspace"}`. Its MCP endpoint is `https://app.example/w/team-one/mcp`. The app serves metadata and a Bearer challenge for that URL. An agent with client ID `https://agent.example/client.json` serves JSON containing that `client_id`, a name, and `redirect_uris: ["http://127.0.0.1/callback"]`. It follows issuer discovery and opens `/authorize` with scope `read`, the MCP URL as `resource`, `state` and S256 challenge. The person signs in and approves. After the callback, the agent redeems the code with the exact loopback URI, resource and verifier. It sends the access token only to that MCP endpoint. The app verifies `aud` equals the MCP URL and checks that `sub` is still a member of `team-one` with read permission. The person later revokes the grant at `/account`; refresh then fails. The app may still accept the existing JWT until its expiry unless it processes the revocation event or maintains local revocation state.

## Per-app policy

| Setting | Effect |
|---|---|
| `agent_access` | `off` by default; `on` enables agent grants. |
| `agent_registration_methods` | Defaults to metadata documents; `dynamic` is explicit. |
| `agent_allowlist` | Empty means unrestricted; exact HTTPS client ID URLs or hosts can restrict metadata agents. A nonempty list excludes dynamic agents. It does not authenticate: only agents that publish keys (`private_key_jwt`) are authenticated. |
| `agent_scope_catalogue` | Scope-to-description map; enabled apps need a nonempty map. |
| `agent_resource_prefixes` | Canonical HTTPS resource ownership; enabled apps need a prefix. |
| `agent_max_grant_days` | Defaults to 90; caps the person's grant. |

Policies are rechecked before consent, code/device redemption and refresh. A grant does not extend if the app later raises its cap. The app must still intersect every scope with local role policy. See [Configuration](CONFIGURATION.md) for registration defaults and validation.

## Metadata and redirect boundaries

Client ID metadata fetches accept HTTPS JSON only. The document's `client_id` must equal its URL. Fetches have one five-second deadline over DNS, HTTPS and body reads, a 64 KiB DNS/body cap, no redirects, and public-address checks for both A and AAAA records. Literal private, loopback, link-local and other special-purpose targets fail. The fixed Cloudflare DNS-over-HTTPS resolver and Workers public-network egress are part of this boundary; DNS checking is not IP pinning. Cache freshness is HTTP-controlled, at least five minutes and at most one hour, in at most 2,000 D1 rows. Expired failures do not use stale documents. Deployment must still qualify egress and rebinding behavior.

Agent redirects are exact HTTPS URLs or HTTP loopback on `localhost`, `127.0.0.1` or `[::1]`. Only the loopback port can vary at authorization; exchange uses the exact requested URI. Resources are canonical HTTPS URLs with no query, fragment or encoded slash, backslash or dot. A request with duplicate `resource` parameters or multiple owners fails. Agent codes are single-use and live 60 seconds. Dynamic registrations unused for 30 days are rejected and swept. No failed metadata fetch switches to dynamic registration.

Client 0.2.0 requires `grant_id` in access JWTs, so apps can deny exactly `(sub, aud, grant_id)` after a verified
revocation. See the [back-channel handler and adoption steps](https://github.com/Vibernt/imprim/blob/main/packages/imprim-client/README.md).

Access JWTs also carry `grant_issued_at`: when the person approved the grant, in seconds. Unlike `iat`, it never
changes when the agent refreshes, so a resource can demand a fresh approval for a dangerous action (for example a
one-shot owner approval valid for 60 seconds) by comparing `grant_issued_at` with its own clock. The client's
`verifyAccessToken` returns it with the other claims; no client update is needed to read it.
