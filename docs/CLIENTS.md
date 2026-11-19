# Registering an app and signing in

A realm admin registers each app, in the console (`<issuer>/admin` → Clients), through the
[admin API](CONTROL_PLANE.md) or offline with `scripts/seed-client.mjs`, after reviewing its callback, logout and
back-channel URLs. There is no self-service app registration; dynamic registration is for agents only. If the app
is moving existing users to Imprim, import them first so they keep their ids as `sub`
([Operations](OPERATIONS.md#importing-existing-users)). The zero-dependency `imprim-client` package implements the
relying-party flow.

## Registration

Choose a unique stable id such as `my-app`. The console generates a confidential client's secret and shows it once.
For offline seeding, use a cryptographically random 32-byte secret. Store the plaintext in the app's secret manager;
Imprim stores only its SHA-256 hex digest. Never put a secret in a browser bundle or commit it in SQL. Example
offline generation (stdout is sensitive; capture it securely):

```bash
node --input-type=module -e 'import {randomBytes,createHash} from "node:crypto"; const secret=randomBytes(32).toString("base64url"); console.log(JSON.stringify({secret,secret_hash:createHash("sha256").update(secret).digest("hex")}))'
```

Review the exact URLs with the app owner; the domains and paths below are examples.

`sign_in_methods` is an ordered JSON array of distinct methods, in display order: `email`, `password`, `passkey`,
`github`, `google`, or a provider id from the realm's config, such as `microsoft` ([Realms](REALMS.md)). Example:
`["google"]` offers only Google and refuses the email-link and GitHub endpoints. Empty arrays, unknown values and
duplicates are rejected. Disabled methods are refused at start and at completion, not only hidden. An SSO session
from a method the app does not allow needs a fresh sign-in. `passkey` adds "Sign in with a passkey" (people add
passkeys at `/account/mfa`). With `password`, the sign-in page shows a password field and an "email me a link to
set one" action ([Protocol](PROTOCOL.md#sign-in-and-sessions)).

`google_hosted_domains` is an optional list of distinct lowercase Google Workspace domains, stored as JSON `[]`
when unrestricted. Example: `["example.com","subsidiary.example"]`. Restrictions check Google's signed `hd` claim,
not the email suffix, and apply again to SSO and code exchange. Missing `hd` fails a nonempty restriction. Wildcards,
URLs and `@` prefixes are invalid. This setting restricts Google only; use `["google"]` if every sign-in must prove
Workspace membership. It is independent of signup admission in `allowed_domains`.

For offline seeding, save a JSON object outside Git, for example:

```json
{
  "id": "my-app",
  "secret_hash": "REPLACE_WITH_SHA256_HEX",
  "redirect_uris": ["https://app.example.com/auth/callback"],
  "post_logout_uris": ["https://app.example.com/signed-out"],
  "backchannel_uri": "https://app.example.com/auth/backchannel",
  "signup_policy": "invited",
  "sign_in_methods": ["google"],
  "google_hosted_domains": ["example.com"],
  "branding": {"name": "My app"}
}
```

Generate the SQL:

```bash
node scripts/seed-client.mjs client.json > client.sql
```

The script requires explicit methods, validates domain, callback, branding and agent settings, and generates SQL
only. It accepts a 64-character lowercase SHA-256 hash (or explicit `null` for a public client); replace the
placeholder. The row lands in the `default` realm (the column default) unless you add a `realm_id` to the SQL, and
an existing client id fails rather than being overwritten. Review the SQL, then apply it with `wrangler d1
execute`. The second-factor, DPoP, token exchange and user event settings are set in the console
([Configuration](CONFIGURATION.md#app-client-settings-clients)). Set up a provider's credentials
([Operations](OPERATIONS.md#provider-apps-per-realm)) before an app enables it; missing provider configuration
fails explicitly and no other method is chosen.

`mfa` (`off`, `optional`, `required`), `mfa_trusted_device_days` (0–90) and `agent_consent_mfa` (`off`,
`required`) set the second-factor policy (PROTOCOL.md, Two-factor authentication). Ask for a fresh or stronger
sign-in before a sensitive action with `acr_values=urn:imprim:acr:mfa` and `max_age`, and check `acr` and
`auth_time` in the ID token.

`allowed_domains` uses exact lowercase email domains, without `@`, wildcards or suffix matching. A domain admits a
person only when the sign-in proves the mailbox: an email link, or Google with a signed `hd` equal to the domain.
GitHub's verified flag does not. Under `signup_policy='invited'` a person is admitted once they have reached this
client before, hold a current invitation, or match an allowed domain. An account created through another app is
not admitted here because it exists; the app gets `error=access_denied` at its redirect URI. `open` allows new verified identities;
it grants no permission inside your app. `branding` overrides the realm's branding for this app: name, Fire look, copy, links and logos ([Branding](BRANDING.md)). The back-channel URI receives `logout_token` human events, `revocation_token` agent events and, with `user_events: on`, `event_token` user events, all through durable outboxes. `dev=1` permits exact HTTP localhost redirects
(including the registered port); production clients must use HTTPS. Never register broad wildcard callback handlers.

A public client has `secret_hash=NULL`; it must use PKCE, and cannot call the invitations endpoint. Confidential
clients must use `client_secret_basic`, not form-post secrets. Rotate a secret in the console or with
`rotate-secret` ([Control plane](CONTROL_PLANE.md)): the new secret is shown once and the old one stops working at
once, with no overlap, so switch the app in the same window.

## Authorization-code round trip

1. Generate independent random `state`, `nonce` and a 43–128-character PKCE verifier in the app. Retain all three
   in the app's own expiring, single-use server-side login transaction, bound to that browser. Compute
   `base64url(SHA256(verifier))` without padding.
2. Redirect the browser to identity:

   ```text
   https://id.example.com/authorize?client_id=my-app&redirect_uri=URL_ENCODED_CALLBACK&response_type=code&scope=openid%20email&state=RANDOM_STATE&nonce=RANDOM_NONCE&code_challenge=S256_DIGEST&code_challenge_method=S256
   ```

   Imprim reuses its own 30-day host-only session when it can. Otherwise it offers the client's configured methods
   and resumes the request. `prompt=none` returns `login_required` if interaction is needed; the app decides whether to start a
   new interactive login. No cross-domain cookies are shared. Do not use third-party iframes for silent login.
3. At the callback, atomically consume the app's login transaction. Check exact `state` and the authorization
   response `iss=https://id.example.com` **before** exchanging the code. Handle `error` without creating a session.
4. POST to `/token` with `grant_type=authorization_code`, `code`, exact original `redirect_uri`, and `code_verifier`.
   Use HTTP Basic with form-encoded client id and secret for confidential clients; public clients send `client_id`.
   Do not forward the browser's cookies. Codes expire after 60 seconds and are single-use. Retry by starting a new
   authorization if the exchange result is lost; code replay is never successful.
5. Verify the ID token cryptographically using JWKS, allowing **only the algorithm your app chose** (ES256, with an EC
   P-256 key, unless the app's `id_token_signed_response_alg` is RS256) and a key matching `kid`. `imprim-client`
   verifies ES256 only, so an app using it keeps the default. Do not trust unverified header algorithms or follow a token-supplied key URL. Check `iss`, `aud`,
   `azp`, `exp`, `iat` with bounded clock skew, and your exact stored `nonce`. Reject unknown/malformed claims.
   Cache keys, and refresh once on unknown kid against the fixed issuer JWKS URL; a long cache alone is insufficient
   for one-hour key prepublication. Validation failures do not create app sessions.
6. Upsert the app's local user record keyed by `(iss, sub)` (an imported user keeps their old id as `sub`). Apply
   the app's authorization policy before creating a host-only session and CSRF token. Apps opted in to shared
   workspaces can read membership and base roles from Imprim. [Shared workspaces](WORKSPACES.md)

Access tokens last ten minutes and are only for `GET /userinfo` or `POST /userinfo`, via `Authorization: Bearer …`. ID tokens are not
accepted as UserInfo credentials. Human app grants have no refresh tokens; apps retain local sessions and use top-level identity
redirects when another authentication is needed. Existing local app sessions should continue during Imprim outages.

## Invite a person

After the app's own authorization approves an invitation, call `POST /v1/invitations` with Basic credentials,
`Content-Type: application/json`, and `{ "email": "member@example.com" }`. A 201 response has `accepted:true` and
an `expires_at` epoch-millisecond timestamp 30 days ahead. Repeating updates the expiry. The client identity comes
from authenticated credentials, not a caller-selected client. Invitations are scoped to that client and normalized
email. This call registers admission; it does not send mail or grant workspace membership.

## Sign out

An app session minted from an Imprim sign-in must expire within 30 days of that sign-in.
Imprim retains the client/subject/session association for 30 days after creation and sends back-channel logout
only for unexpired associations. Renewing a local session alone does not extend that association. Require a new
identity sign-in before minting a session that would exceed the 30-day limit.

Delete the app's own session under its own CSRF policy first. Redirect the browser to:

```text
https://id.example.com/logout?client_id=my-app&post_logout_redirect_uri=URL_ENCODED_REGISTERED_URI&state=APP_LOGOUT_STATE
```

Imprim validates the return URI and asks for explicit CSRF-protected confirmation before deleting its own session.
Validate your returned logout state. You can also pass `id_token_hint`; it must be signed by this issuer and match
the client and current session. Every app with a session from that sign-in then receives a signed back-channel
`logout_token`, delivered at least once; ending its session is each app's job.

## App-side tests before going live

Wrong or missing state, replayed callback transaction or code, swapped nonce, wrong issuer, audience or `azp`,
expired token, `alg=none` or HS256 substitution, untrusted key URL, unknown `kid` refresh, client-secret failure,
blocked or deleted account, the no-admission page, agent-connect approval continuation, local logout and CSRF, and
an Imprim outage with an existing app session. Imprim's own suite does not replace these tests in your app, or
OpenID conformance.

## Worker app using the client

Install the workspace package or vendor `dist/imprim-client.mjs`. Keep `clientSecret` in a Worker secret, never in browser JavaScript. The app owns its login transaction, cookie, local session, admission and CSRF checks.

```js
import { createClient, IdentityError } from 'imprim-client';

const client = createClient({
  issuer: 'https://id.example.com', clientId: 'my-app',
  clientSecret: env.IDENTITY_CLIENT_SECRET,
  redirectUri: 'https://app.example.com/auth/callback'
});

// Login handler: put these three values in an expiring, browser-bound,
// single-use server-side transaction referenced by an HttpOnly Secure cookie.
const login = await client.startLogin({ method: 'google' });
await saveLoginTransaction(login.state, { nonce: login.nonce, codeVerifier: login.codeVerifier });
return Response.redirect(login.url, 303);

// Callback handler: atomically consume the transaction before exchanging.
const transaction = await consumeLoginTransaction(new URL(request.url).searchParams.get('state'));
const claims = await client.handleCallback(request.url, { state: transaction.state, ...transaction.values });
await applyLocalAdmission(claims.sub);
return createAppSession(claims.sub);
```

`handleCallback` returns verified claims and throws `IdentityError` with a stable `code`. Treat errors as failed login and create no app session. The app must protect its transaction cookie and reject reuse; the client checks response state, issuer, token signature and claims. `startLogin({prompt:'none'})` uses the existing top-level identity session. The optional `method` query records an app preference, but the server presents the client's configured method list and does not force that preference. Server settings enforce which methods can complete.

Pass `{ idToken: true }` as the third argument to `handleCallback` to receive `{ claims, idToken }` after verification.
Store the ID token with the app's server-side session, send it only to Imprim as `actor_token`, and never send it to a browser or write it to a log.

`client.logoutUrl({idTokenHint,postLogoutRedirectUri,state})` produces the identity confirmation URL; end the local session under app CSRF first. `client.inviteEmail(email)` requires a confidential client and registers identity admission only. Also for confidential clients (0.7.0): `client.listGrants({resource, sub?, limit?, cursor?})` returns one page of live agent grants on one of the app's resources as `{grants, next_cursor}` (pass `next_cursor` back as `cursor`; it is `null` on the last page); `client.revokeGrant(grantId)` revokes one; `client.introspect(token, {tokenTypeHint?})` returns RFC 7662 `{active: false}` or the live token's claims, `agent_assurance` included. `handleBackchannelLogout(request)` verifies a signed logout token and returns `{sub,sid,jti}`; the app must persist consumed `jti` values, apply each event only once, and acknowledge duplicates with 2xx. Human back-channel logout is delivered through a durable outbox; agent revocation events use the distinct contract below. Return 2xx for authenticated duplicate deliveries after durable deduplication.

Run `node scripts/build-client.mjs` to regenerate the single-file vendored artifact. Its first line records the package version and the SHA-256 of the remaining exact UTF-8 body. Verify both before accepting a vendored copy.

## Agent access

App clients and agent clients are separate registries. `/register` creates only a public **agent**; it cannot create an
app, register a resource prefix, change admission, or obtain client credentials. Registration alone grants nothing.
A realm admin configures agent access on the owning app, in the console or the seed file. Every app starts with
agent access off. Add these settings to the client:

```json
{
  "agent_access": "on",
  "agent_registration_methods": ["metadata_document", "dynamic"],
  "agent_allowlist": [],
  "agent_scope_catalogue": {"read": "Read workspace", "write": "Edit workspace"},
  "agent_resource_prefixes": ["https://app.example/w/"],
  "agent_max_grant_days": 90
}
```

| Setting | Default and contract |
|---|---|
| `agent_access` | `off`; only `on` enables grants. Switching `on` → `off` revokes every live grant for the app and sends each revocation event; switching back on revives none. |
| `agent_registration_methods` | `["metadata_document"]`; allow `dynamic` explicitly for RFC 7591 clients. |
| `agent_allowlist` | `[]` means unrestricted. Otherwise exact canonical HTTPS client-ID URLs or lowercase hosts (matched on the full host, so another port never matches); no wildcards or suffix matching. A nonempty list excludes dynamic clients. **The allowlist narrows which client IDs may ask; it does not authenticate them.** Any local program can claim an allowlisted ID whose document lists loopback redirects. Prefer agents that publish keys (`private_key_jwt`), and exact URL entries over hosts. Do not allowlist hosts that serve user content. |
| `agent_scope_catalogue` | `{}`; map scope names to human-readable descriptions. Enabled apps need at least one. No implicit `openid` or `offline_access` scope is added. |
| `agent_resource_prefixes` | `[]`; canonical HTTPS URLs without queries/fragments. Match same origin and complete path boundaries. Enabled apps need at least one. Ambiguous ownership fails. |
| `agent_max_grant_days` | `90`; positive whole days. A reduced cap also restricts existing grants; increasing it never extends their originally consented expiry. |

Policies are read at authorization, sign-in continuation, consent, code/device redemption and refresh. Atomic issuance
also checks the validated policy snapshot and current user state. Agent SSO uses the owning app's allowed sign-in
methods and Google hosted domains. Signup admission remains the app's existing invited/open policy.

The resource must name one workspace, for example `https://app.example/w/team-one/mcp`. Imprim validates registered
ownership and requires membership at consent for resources registered to active shared workspaces. The resource
server must intersect scopes with the person's current membership and role **on every request**. Its expected audience comes from its own route/configuration, never a
client-supplied query parameter or the token's unverified claims.

A metadata-document agent serves `application/json` at its HTTPS client-ID URL:

```json
{
  "client_id": "https://agent.example/client.json",
  "client_name": "Example Agent",
  "redirect_uris": ["http://127.0.0.1/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"]
}
```

An agent that can keep a private key should publish it and authenticate (recommended). The consent screen then
shows its host as verified, and nobody else can redeem codes or start device flows under its client ID:

```json
{
  "client_id": "https://agent.example/client.json",
  "client_name": "Example Agent",
  "redirect_uris": ["http://127.0.0.1/callback"],
  "token_endpoint_auth_method": "private_key_jwt",
  "jwks_uri": "https://agent.example/jwks.json",
  "grant_types": ["authorization_code", "refresh_token"]
}
```

Every `/token` and `/device_authorization` request then adds `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
and `client_assertion`, a JWT signed ES256 or RS256 by a key in that set, with `iss` and `sub` equal to the client
ID, `aud` equal to the issuer or the endpoint URL, `exp` at most five minutes ahead, and a fresh `jti` (each one
is accepted once). `jwks_uri` must be on the client ID's host; inline `jwks` is also accepted.

Alternatively, `POST /register` with `client_name` and `redirect_uris` returns HTTP 201 with the generated `client_id`,
`client_id_issued_at`, and accepted public metadata; no secret or registration-management token is issued. Both
registrations allow only code responses and the three agent grant types shown above. If `grant_types` is omitted,
only `authorization_code` and `refresh_token` are allowed: **the device grant must be declared.** `client_name` is
stripped of bidirectional and invisible characters. The client ID URL must use the default HTTPS port. HTTP redirects may use `127.0.0.1`, `[::1]`, or `localhost` with any port; host/path/query still
match. HTTPS redirects match exactly, including port. Exchange uses the exact URI from the authorization request.

The browser flow uses `/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `state`, `scope`, exactly one
`resource`, `code_challenge`, and `code_challenge_method=S256`. Agent requests are OAuth, not OIDC: no nonce or ID token.
Explicit consent is required every time; `prompt=none` fails with `consent_required`. Exchange the single-use code at
`/token` with the original client, resource, redirect URI and verifier. Refresh with `grant_type=refresh_token`,
`client_id`, the same `resource`, and `refresh_token`. Persist each replacement atomically and serialize refreshes.
If a refresh response is lost, retry with the same token within 10 seconds: that rotates once more. Any later use
of a spent token revokes the entire grant; recover by asking the person to consent again. Send `scope` with a
subset of the grant's scopes to get a narrower access token; the new refresh token keeps the full grant. A grant
allows 3,000 refreshes a day, about twice what a 60-second token needs.

For headless login, POST a form to `/device_authorization` with `client_id`, `resource`, and `scope`. Display the
returned `user_code` and `verification_uri` (or open `verification_uri_complete`). Poll `/token` with
`grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`, and the same `resource` after the
returned interval. `authorization_pending` means wait; `slow_down` adds five seconds to all later polling intervals;
`expired_token` and `access_denied` end the flow. Device authorization uses its device secret and explicit human
approval; S256 applies to the authorization-code flow, not RFC 8628 polling. `/account/agents` lists and revokes grants.

### Resource server helpers

```js
const resource = 'https://app.example/w/team-one/mcp'; // trusted route-derived audience
const resourceMetadataUrl = 'https://app.example/.well-known/oauth-protected-resource/w/team-one/mcp';
// Serve this JSON at resourceMetadataUrl (and support browser CORS if your app requires it).
const metadata = client.protectedResourceMetadata({ resource, scopes: ['read', 'write'] });
// Missing token:
const unauthorized = new Response(null, {
  status: 401,
  headers: { 'WWW-Authenticate': client.wwwAuthenticate({ resourceMetadataUrl }) }
});
// A supplied bearer token:
const claims = await client.verifyAccessToken(token, { audience: resource });
await requireCurrentMembershipAndScope(claims.sub, resource, claims.scope);
```

`verifyAccessToken` verifies ES256/P-256, trusted issuer JWKS, `typ=at+jwt`, exact scalar audience, required claims,
expiry and a maximum 60-second lifetime. It returns `AccessClaims` or throws `IdentityError`; it never accepts an
ID token as an API token. The package also exports `wwwAuthenticate({resourceMetadataUrl,error?})`; allowed errors
are `invalid_request`, `invalid_token`, and `insufficient_scope`. No token is passed through to another API.
Verification is offline against cached issuer keys: a revoked grant's already-issued access token remains usable
until its expiry (at most 60 seconds), unless the app applies an additional local revocation policy.

Agent revocations POST a signed `revocation_token` to the app's registered back-channel URI. This is distinct from
OIDC `logout_token`; see PROTOCOL.md for the event contract. `handleBackchannelLogout` deliberately does not accept
agent revocation events. Apps must verify the dedicated event and persist its `jti` before acknowledging delivery.

## Upgrading from identity-client 0.2.0

Apps that vendored `@vibernt/identity-client` 0.2.0 keep working against a current server for sign-in, sign-out and
back-channel logout: the issuer, client ids, secrets, callback URLs and every person's `sub` are unchanged. One thing
does not work until the app upgrades: **0.2.0 refuses agent revocation events**, because the server signs them as
`typ=secevent+jwt` and 0.2.0 accepts only `typ=JWT`. A revoked grant still stops refreshing at once and its access
token expires within 60 seconds; what the app loses is the earlier, event-driven denial.

To upgrade:

1. Build the client: `node scripts/build-client.mjs` writes `dist/imprim-client.mjs`. Its first line is
   `// imprim-client <version> body-sha256 <digest>`. Copy it over the vendored file and update any check that pins
   the old header (`// @vibernt/identity-client 0.2.0 …`), in the same commit.
2. Keep your code as it is: `createClient`, `startLogin`, `handleCallback`, `verifyBackchannel`, `verifyAccessToken`,
   `logoutUrl`, `inviteEmail` and the named exports have the same signatures.
3. Check these three places, which behave differently:
   - **Error text.** `IdentityError.message` is now always the package's own text. The server's
     `error_description` is in `error.description`: untrusted, escape it before display. If you showed or matched
     `error.message`, switch.
   - **DPoP-bound agent tokens.** If your resource server reads `Authorization`, accept the `DPoP` scheme as well as
     `Bearer` and pass the proof to `verifyAccessToken` (the package README shows how). Until you do, a bound token
     fails with `invalid_dpop_proof`; agents that send no proof are unaffected.
   - **Back-channel kinds.** `verifyBackchannel` can return `kind: 'user'`, but only for an app that turns
     `user_events` on. A handler that switches on `kind` needs no change while that is off.
4. Run your own tests, then `IMPRIM_CLIENT_PATH=/path/to/your/vendored/file node --test tests/server-backchannel.test.mjs`
   in this repository, which checks your copy against the server's logout wire contract.
5. If your app links people to their connected agents, the page is now `<issuer>/account/agents` (it was on
   `<issuer>/account`, which is now the profile page).

What each version changed:

| Version | Change |
|---|---|
| 0.3.0 | Wire change: agent revocation events are `secevent+jwt`. `iss` is required on the authorization response. Error text handling, JWKS refresh after 10 minutes, a failed discovery is not cached. Details below. |
| 0.4.0 | Step-up: `startLogin({ acrValues, maxAge })`; ID tokens carry `acr`. |
| 0.5.0 | `verifyAccessToken` checks a DPoP proof for a bound token (`dpop`, `requireDpop`) and returns `dpop_jti`. |
| 0.8.3 | Types only: workspace reads include `created_via` (`'signup'` or `null`). Nothing else changes. |
| 0.8.2 | Every request uses `redirect: 'manual'` and treats any redirect as a failure, so the client works inside Cloudflare Workers, which reject `redirect: 'error'`. Nothing else changes. |
| 0.8.1 | `handleCallback` can return the ID token for `actor_token`. Nothing else changes. |
| 0.8.0 | Shared and personal workspace methods for confidential clients. `verifyBackchannel` accepts `workspace_token` and returns `kind: 'workspace'`. |
| 0.7.0 | `listGrants` (paged, `sub` filter), `revokeGrant` and `introspect` for confidential clients. |
| 0.6.0 | User lifecycle events: `event_token`, `verifyUserEventToken`, `handleUserEvent`, and `kind: 'user'` from `verifyBackchannel`. The package is named `imprim-client`. |

Nothing new is on until an app's client turns it on: second factor, passwords, passkeys, DPoP, token exchange and
user events all default to off. Shared workspaces require opt-in on the realm and the app.

## Client 0.8.0 workspace methods

| Operation | Methods |
|---|---|
| Read | `memberships(sub)`, `workspace(id)`, `workspaceMembers(id, { limit, cursor })`, `workspaceInvitations(id)` |
| Manage workspaces | `createWorkspace(options)`, `renameWorkspace(id, options)`, `setWorkspaceProducts(id, options)`, `closeWorkspace(id, options)` |
| Manage people | `inviteToWorkspace(id, options)`, `revokeWorkspaceInvitation(id, invitationId, options)`, `setMemberRole(id, sub, options)`, `removeMember(id, sub, options)` |
| Manage app holds and resources | `holdWorkspace(id, reason)`, `releaseWorkspace(id, reason?)`, `registerWorkspaceResource(id, resource)`, `unregisterWorkspaceResource(id, resource)` |

Pass `actorToken` in the options for actions on a person's behalf. The client sends it as `actor_token` in the
JSON body and uses HTTP Basic app credentials for every request. For `kind: 'workspace'`, `verifyBackchannel`
returns claims `{ event, workspaceId, sub, version, payload, jti }`. [App API and events](WORKSPACES.md#app-api)

## Client 0.3.0 changes (wire change)

- Agent revocation events are RFC 8417 security events: `typ=secevent+jwt`, event type `<issuer>/events/agent-revoked`.
  0.3.0 accepts only that form; 0.2.0 accepted `typ=JWT`. Delivery re-signs on every retry for 24 hours, so either
  deploy order converges, but upgrade apps and the server in the same window.
- `handleCallback` requires `iss` on the authorization response (RFC 9207), as discovery advertises.
- `IdentityError.message` is always the package's own text. A server's `error_description` is in `error.description`:
  untrusted, escape it before display.
- JWKS is refetched after 10 minutes; keys up to 24 hours old keep verifying only while Imprim is unreachable.
- A failed discovery is not cached.
- ID tokens carry `email` and `email_verified` only when you request the `email` scope (the default `startLogin` does).

## Client 0.2.0 back-channel adoption

Use `verifyBackchannel(form)` at the registered back-channel URI to accept both `logout_token` and
`revocation_token`. Persist the verified jti and effect atomically; return 2xx for authenticated duplicates.
Agent tokens now include `grant_id`; check a denial keyed by `(sub, aud, grant_id)` on every agent request.
Logout with no sid ends all local sessions for sub. The full handler, exact claim shapes, clock rules and
upgrade steps are in the [package README](https://github.com/Vibernt/imprim/blob/main/packages/imprim-client/README.md).
