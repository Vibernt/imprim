# imprim-client 0.12.0

Zero-dependency OIDC relying-party and resource-server client for any app of any realm. Versions up to 0.2.0 were
named `@vibernt/identity-client`. To move an app from that version, follow
[Upgrading from identity-client 0.2.0](../../docs/CLIENTS.md#upgrading-from-identity-client-020); what each version
changed is listed there.

Native ESM for Workers and Node 20+. `index.mjs` and `index.d.ts` are the package
entry points. Apps retain authorization, memberships, their own sessions and CSRF, and single-use browser-bound
login transactions. See [client integration](../../docs/CLIENTS.md#worker-app-using-the-client).

Use one long-lived `createClient({ issuer, clientId, redirectUri, resourcePrefixes, fetch })` instance per app
configuration to share discovery and 24-hour JWKS caching. `redirectUri` is required for `startLogin` and
`handleCallback`; verification-only clients can omit it. `resourcePrefixes`, when supplied, is an array of canonical
HTTPS resource prefixes; an empty array denies every revocation resource. Matching requires the same origin and
an exact path or path-segment prefix (not a string prefix such as `/w` matching `/wrong`). Configuration is copied
at creation. Network/key failures throw `IdentityError`; no alternate issuer or stale-key fallback is used.

Pass `{ idToken: true }` as the third argument to `handleCallback` to receive `{ claims, idToken }` after verification.
Store the ID token with the app's server-side session, send it only to Imprim as `actor_token`, and never send it to a browser or write it to a log.

## Back-channel events

Apps must expire a session minted from identity sign-in within 30 days of that sign-in; shorter is better (seven days is a good default).
The issuer retains each app-session association for 30 days after creation. Block, delete, logout and merge
send human logout events only to clients with an unexpired association. A local session renewal does not extend
the association; use a new identity sign-in before creating a session beyond this limit.

Imprim posts `logout_token` (a session ended), `revocation_token` (an agent grant was revoked), `event_token`
(an account changed, with `user_events: on`) and `workspace_token` (a participating workspace changed).
All use ES256 signatures against the issuer's discovery JWKS. An unknown `kid` triggers one refresh,
rate-limited to once per minute per client instance. Verification requires exact issuer and scalar client-id audience,
integer `iat`/`exp`, `0 < exp - iat <= 900`, and exactly one event object. Expired tokens are refused at `exp`
with no expiration leeway. `clockSkewSeconds` (integer 0–60, default 60) bounds future `iat`/`nbf` acceptance only.
No kind accepts `nonce`, and no verifier accepts another kind's token.

- `client.verifyLogoutToken(token, { clockSkewSeconds? })` requires `typ: logout+jwt`, event
  `http://schemas.openid.net/event/backchannel-logout`, nonempty `jti`, and `sub` or `sid` (each nonempty if present).
  Returns `{ sub, sid, jti, iat, exp }`. Identity emits `sub` always, `sid` when session-scoped, and a 120-second lifetime.
- `client.verifyRevocationToken(token, { clockSkewSeconds? })` requires `typ: secevent+jwt` (RFC 8417), event
  `<issuer>/events/agent-revoked`, nonempty `sub`, `jti`, `grant_id`, and `resource`. The canonical resource
  must match `resourcePrefixes` when configured. Returns `{ sub, jti, grantId, resource, iat, exp }`.
  Identity emits a 300-second lifetime; the verifier's interoperability cap is 900 seconds.
- `client.verifyUserEventToken(token, { clockSkewSeconds? })` (0.6.0) requires `typ: secevent+jwt`, exactly one event
  under `<issuer>/events/` from `user-updated`, `user-blocked`, `user-unblocked`, `user-deleted`, `user-merged` and
  `mfa-reset`, nonempty `sub` and `jti`, and an integer `toe` (when the change happened). Returns
  `{ sub, jti, event, data, toe, iat, exp }`; `data` is `{ fields }` for `user-updated` (which of `name` and `email`
  changed, never the value) and `{ into }` for `user-merged`. Apply the event with the latest `toe` for each person.
- `client.verifyBackchannel(form, options?)` accepts `URLSearchParams` or `FormData` with exactly one string
  token field. It returns `{ kind, claims }`, with `kind` set to `'logout'`, `'revocation'`, `'user'` or
  `'workspace'`. For `workspace_token`, it verifies `typ: secevent+jwt` and an issuer-relative workspace event.
  Its claims are `{ event, workspaceId, sub, version, payload, jti }`, with `sub` set on member events.
  Deduplicate `jti`, apply higher versions and catch up through `workspaceMembers`.

`verifyBackchannel`, `verifyLogoutToken` and `verifyRevocationToken` are also named exports taking client configuration plus optional `clockSkewSeconds` as their second
argument, for example `verifyRevocationToken(token, { issuer, clientId, resourcePrefixes, fetch })`. These one-shot
calls create a new client; use the instance methods for shared caches. `handleBackchannelLogout(request)`,
`handleAgentRevocation(request)` and `handleUserEvent(request)` take a form-encoded POST and accept only their own
kind. They return `{ sub, sid, jti }`, `{ sub, grant_id, resource, jti }` and `{ sub, event, data, toe, jti }`.

A single receiver URI can handle all four kinds.

```js
import { createClient, IdentityError } from 'imprim-client';
const identity = createClient({
  issuer: 'https://YOUR_REALM_HOST', clientId: 'YOUR_REGISTERED_CLIENT_ID',
  resourcePrefixes: ['https://YOUR_APP_HOST/w/']
});

export async function backchannel(request, appStore) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/x-www-form-urlencoded') return new Response(null, { status: 415 });
  let form;
  try { form = await request.formData(); }
  catch { return new Response(null, { status: 400 }); }
  let event;
  try { event = await identity.verifyBackchannel(form); }
  catch (error) {
    if (error instanceof IdentityError && ['invalid_token', 'invalid_response'].includes(error.code))
      return new Response(null, { status: 400 });
    throw error; // Dependency/configuration failures must not be acknowledged.
  }
  // App-provided durable transaction: insert jti only if unseen and apply its effect atomically.
  // logout: end sessions for sub + sid, or ALL sessions for sub if sid is absent.
  // revocation: deny exactly (sub, resource, grantId), without ending human sessions.
  // user (only with user_events: on): refresh or remove what you hold about sub; keep the latest toe.
  // workspace: apply higher versions only, and use workspaceMembers to catch up if needed.
  // Authenticated duplicate jti: no effect, successful return. Storage failures must throw.
  await appStore.applyBackchannelOnce(event);
  return new Response(null, { status: 204 });
}

export async function agentRequest(token, resource, appStore) {
  const claims = await identity.verifyAccessToken(token, { audience: resource });
  if (await appStore.isGrantRevoked(claims.sub, claims.aud, claims.grant_id))
    throw new Error('Grant revoked');
  // Also check current membership and intersect claims.scope with the person's role on EVERY request.
  return claims;
}
```

`appStore` above is an application-owned storage interface, not SDK-provided persistence. Do not acknowledge before
its durable commit. Key replay records by trusted issuer and `jti` if accepting multiple issuers. Identity can re-sign
an outbox event later with the same `jti`; preserve replay records while retries are possible. Grant denials must
cover all unexpired tokens, and logout/denial effects must remain idempotent on retries. No storage is held by the SDK.

## User profiles (0.10.0)

After verifying a `user-updated` event, use a confidential client to fetch the person's current profile.

| Method | Arguments and result |
|---|---|
| `user` | `sub`. Returns `{ sub, email, email_verified, name }` for a person the app currently admits. `name` is `null` when unset. |

## Agent grants (0.7.0)

For a confidential client, the calls a workspace admin screen needs:

- `client.listGrants({ resource, workspace_id?, sub?, limit?, cursor? })` returns `{ grants, next_cursor }`: one page (up to 200) of
  the live agent grants on one of the app's resources, newest first. Pass `next_cursor` back as `cursor`; it is `null`
  on the last page. `sub` narrows the list to one person. `workspace_id` narrows it to one workspace using the app's
  product. Each grant includes `workspace_id`, which is null for grants without a workspace choice.
- `client.revokeGrant(grantId)` revokes one; the agent's refresh stops and a revocation event follows.
- `client.introspect(token, { tokenTypeHint? })` returns `{ active: false }`, or the live token's claims, including
  `agent_assurance` (`key`, `redirect`, `claimed` or `none`).

## Shared and personal workspaces (0.8.0)

Create a client with `clientSecret` for a participating app. Pass the app's Imprim ID token as `actorToken`
for actions on a person's behalf.

| Method | Arguments |
|---|---|
| `memberships` | `sub` |
| `joinableWorkspaces` (0.9.0) | `{ actorToken }`. Returns `{ workspaces }` for up to 100 active team workspaces the person owns that do not use the app's product. The app needs `workspace_admin` enabled. |
| `workspace` | `id` |
| `workspaceMembers` | `id, { limit?, cursor? }` |
| `createWorkspace` | `{ name, products, firstOwnerEmail, actorToken }` for a team or `{ kind: 'personal', name, actorToken }`. For a team, pass the app's own product in a one-item array. The App API also defaults to that product when the field is omitted. |
| `renameWorkspace` | `id, { name, actorToken }` |
| `setWorkspaceProducts` | `id, { add, remove, actorToken }`. Both arrays may contain only the app's own product. |
| `inviteToWorkspace` | `id, { email, role, actorToken }` |
| `workspaceInvitations` | `id` |
| `revokeWorkspaceInvitation` | `id, invitationId, { actorToken }` |
| `setMemberRole` | `id, sub, { role, actorToken }` |
| `removeMember` | `id, sub, { actorToken }` |
| `closeWorkspace` | `id, { actorToken, confirm?, releaseOwnHold? }`. `releaseOwnHold: true` (0.11.0) lets the app's own hold stop blocking and removes it only if the close succeeds; other apps' holds still block. |
| `holdWorkspace`, `releaseWorkspace` | `id, reason` (optional for release) |
| `registerWorkspaceResource` | `id, resource, { name }?`. The optional name is trimmed and must be 1–80 characters without control characters. Omit it or pass null to keep the current name. Pass an empty string to clear it. |
| `unregisterWorkspaceResource` | `id, resource` |

Pass a page's `next_cursor` as `cursor` to fetch the next members page. See the [workspace specification](../../docs/WORKSPACES.md).

## Machine clients for a workspace

A confidential shared app with agent access can request an unattended service identity. Send the returned
`approval_url` to a workspace owner or admin. The request expires after 24 hours. The approved client uses
`private_key_jwt` at the issuer's token endpoint and can request one of its approved resource URLs exactly.

| Method | Arguments and result |
|---|---|
| `requestMachineClient` | `workspaceId, { name, jwks, scopes, resources }` → `{ request_id, approval_url, expires_at }`. Send public keys only. |
| `machineClientRequest` | `workspaceId, requestId` → `{ request_id, status, service_client_id?, expires_at }`. |
| `machineClients` | `workspaceId` → `{ machine_clients }` for this app and workspace. |
| `disableMachineClient` | `workspaceId, clientId, { actorToken }` → `{ client_id, disabled: true }`. The app's ID token must identify a current owner or admin, or the accountable person. |

For a workspace machine token, `verifyAccessToken` returns `workspace_id` and `accountable_sub` as strings, while
`sub` stays `service:<id>`. Verify the exact audience, use the workspace claim to scope access, and authorize the
service identity with its approved scopes. Use `introspect` when you need current liveness before the 60-second
token expires. [Workspace API and lifecycle](../../docs/WORKSPACES.md#machine-clients).

## Agent access and adoption

`verifyAccessToken(token, { audience, clockSkewSeconds })` requires a signed `at+jwt`, exact workspace-resource audience, nonempty
`grant_id` (added to server access tokens for 0.2.0), and at most **60 seconds** between `iat` and `exp`. It rejects
at `exp` with no positive leeway; apps must verify on every request and not cache authorization beyond expiry.
With synchronized clocks, a revoked grant loses access within one minute even if no back-channel arrives, because
refresh is refused immediately. Back-channel denial provides earlier enforcement. Human app sessions still require
logout delivery; access-token expiry does not end them.

Resource servers also use `client.protectedResourceMetadata({ resource, scopes })` and
`client.wwwAuthenticate({ resourceMetadataUrl, error? })`; `wwwAuthenticate` is a named export.

### One resource for every workspace

For a shared-workspace product, reserve `https://app.example/mcp` in the app's `agent_workspace_resources`.
Serve its metadata and use the token's `workspace_id` to look up the person's current role on every call.

```js
const resource = 'https://app.example/mcp';
const metadata = client.protectedResourceMetadata({ resource, scopes: ['read'] });

async function authorizeRequest(token) {
  const claims = await client.verifyAccessToken(token, { audience: resource });
  if (!claims.workspace_id) throw new Error('Workspace choice required');
  // Application code checks the current role and intersects its permissions with the approved scopes.
  await requireCurrentRoleAndScopes(claims.sub, claims.workspace_id, claims.scope);
  return claims.workspace_id;
}
```

**DPoP-bound tokens (0.5.0).** An agent may bind its tokens to a key. Such a token carries `cnf.jkt`, arrives as
`Authorization: DPoP <token>` and comes with a `DPoP` header holding a proof for this request. Pass the proof:

```js
const [scheme, token] = (request.headers.get('authorization') || '').split(' ');
const claims = await identity.verifyAccessToken(token, { audience: resource,
  dpop: scheme === 'DPoP' ? { proof: request.headers.get('dpop'), method: request.method, url: request.url } : undefined });
// claims.dpop_jti is set for a bound token: refuse one you have seen in the last five minutes.
```

A bound token verified without `dpop` fails with `invalid_dpop_proof`; a bearer token still verifies as before.
`requireDpop: true` refuses bearer tokens, for an app whose client sets `agent_dpop: required`.

**Profile scope (0.11.0).** `startLogin({ profile: true })` asks for `openid email profile`; the ID token then carries `name` whenever the person has set one, so an absent `name` means none.

**Step-up (0.4.0).** `startLogin({ acrValues: 'urn:imprim:acr:mfa', maxAge })` asks for a second factor in this
session, or a sign-in no older than `maxAge` seconds. Check `claims.acr === 'urn:imprim:acr:mfa'` and
`claims.auth_time` after the callback before you allow the sensitive action.

**Vendoring.** An app without a package manager can copy `dist/imprim-client.mjs`, built by
`node scripts/build-client.mjs` with a version and body SHA-256 header. Check the header when you update it, and route
both back-channel POST fields through `verifyBackchannel`. Each app configures its own client ID and resource prefixes,
deduplicates events durably, and checks `(sub, aud, grant_id)` on agent requests. Tokens without `grant_id` are refused;
deploy the server before switching app verification and wait out the previous token lifetime (60 seconds).

The tests can also check an app's vendored copy:

```sh
IMPRIM_CLIENT_PATH=/absolute/path/to/app/src/auth/imprim-client.mjs node --test tests/server-backchannel.test.mjs
```

Access-token `iat` and optional `nbf` permit up to 60 seconds of future clock skew by default. Pass
`clockSkewSeconds` as an integer from 0 through 60 to reduce that allowance. `exp` has zero leeway for every
skew setting; the 60-second maximum `exp - iat` is unchanged. Invalid skew settings fail as configuration errors.
