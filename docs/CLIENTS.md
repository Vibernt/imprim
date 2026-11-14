# Registering an app and signing in

App registration has no self-service endpoint or admin console; Dynamic registration is for agents only. A trusted operator registers a client directly in D1 after
reviewing its app-owned callback/logout endpoints. Do not register Assay until the empty-client deployment and
subject-preserving import have been verified. The zero-dependency `imprim-client` package implements the relying-party flow.

## Registration

Choose a unique stable id such as `assay`. Use a cryptographically random 32-byte secret for a confidential server
app. Store the plaintext in the app's secret manager; identity stores only its SHA-256 hex digest. Never put a secret
in a browser bundle or commit it in SQL. Example offline generation (stdout is sensitive; capture securely):

```sh
node --input-type=module -e 'import {randomBytes,createHash} from "node:crypto"; const secret=randomBytes(32).toString("base64url"); console.log(JSON.stringify({secret,secret_hash:createHash("sha256").update(secret).digest("hex")}))'
```

Review the exact URLs with the app owner; the following domains/paths are examples, not Assay's verified callback
contract. Replace values, save SQL in ignored `imports/`, and have the operator apply it to D1:

```sql
INSERT INTO clients(id,secret_hash,redirect_uris,post_logout_uris,backchannel_uri,signup_policy,allowed_domains,branding,dev,sign_in_methods,google_hosted_domains)
VALUES('example-app','REPLACE_WITH_SHA256_HEX',
 '["https://app.example/auth/identity/callback"]',
 '["https://app.example/signed-out"]',NULL,'invited',
 '["example.com"]','{"name":"Example app"}',0,'["email","github","google"]','[]');
```

`sign_in_methods` is a JSON array containing one to three distinct values from `email`, `github`, `google`, in
display order. Example: `["google"]` offers only Google and refuses magic-link and GitHub endpoints. Empty arrays,
unknown values and duplicates are rejected. Existing M1 clients retain `["email","github"]` through migration
0002 (also the SQL column default); explicitly configure this field for new clients. Disabled methods are rejected
on start and completion, not merely hidden. An SSO session from a disallowed method requires a fresh sign-in.

`google_hosted_domains` is an optional list of distinct lowercase Google Workspace domains, stored as JSON `[]`
when unrestricted. Example: `["example.com","subsidiary.example"]`. Restrictions check Google's signed `hd` claim,
not the email suffix, and apply again to SSO and code exchange. Missing `hd` fails a nonempty restriction. Wildcards,
URLs and `@` prefixes are invalid. This setting restricts Google only; use `["google"]` if every sign-in must prove
Workspace membership. It is independent of signup admission in `allowed_domains`.

For validated configuration-driven seeding, save a JSON object in ignored `imports/`, for example:

```json
{
  "id": "example-app",
  "secret_hash": "REPLACE_WITH_SHA256_HEX",
  "redirect_uris": ["https://app.example/auth/identity/callback"],
  "post_logout_uris": ["https://app.example/signed-out"],
  "signup_policy": "invited",
  "sign_in_methods": ["google"],
  "google_hosted_domains": ["example.com"],
  "branding": {"name": "Example app"}
}
```

Run `node scripts/seed-client.mjs imports/client.json > imports/client.sql`. The script requires explicit methods,
validates domain and callback settings, and generates SQL only. It accepts a 64-character lowercase SHA-256 hash
(or explicit `null` for a public client); the placeholder above must be replaced. Review the SQL before an operator
applies it. Existing client IDs fail rather than being overwritten. Configure Google credentials as described in
OPERATIONS.md before enabling Google. Missing provider configuration fails explicitly; no alternate method is chosen.

`sign_in_methods` is an ordered list from `email`, `password`, `passkey`, `github` and `google`. `passkey` adds
"Sign in with a passkey" (people add passkeys at `/account/mfa`). With `password`, the sign-in
page shows a password field and an "email me a link to set one" action (see PROTOCOL.md).

`mfa` (`off`, `optional`, `required`), `mfa_trusted_device_days` (0–90) and `agent_consent_mfa` (`off`,
`required`) set the second-factor policy (PROTOCOL.md, Two-factor authentication). Ask for a fresh or stronger
sign-in before a sensitive action with `acr_values=urn:imprim:acr:mfa` and `max_age`, and check `acr` and
`auth_time` in the ID token.

`allowed_domains` uses exact lowercase email domains, without `@`, wildcards or suffix matching. A domain admits a
person only when the sign-in proves the mailbox: an email link, or Google with a signed `hd` equal to the domain.
GitHub's verified flag does not. Under `signup_policy='invited'` a person is admitted once they have reached this
client before, hold a current invitation, or match an allowed domain. An account created through another app is
not admitted here because it exists; the app gets `error=access_denied` at its redirect URI. `open` allows new verified identities;
it grants no permission inside your app. `branding` currently uses only `name`, escaped as text. Back-channel URI receives distinct `revocation_token` agent events and `logout_token` human events through the M4 durable outboxes. `dev=1` permits exact HTTP localhost redirects
(including the registered port); production clients must use HTTPS. Never register broad wildcard callback handlers.

A public client has `secret_hash=NULL`; it must use PKCE, and cannot call the invitations endpoint. Confidential
clients must use `client_secret_basic`, not form-post secrets. Rotation is a reviewed replacement of the stored
hash and app secret; There is no overlapping-secret grace window or rotation console. Coordinate the switch.

## Authorization-code round trip

1. Generate independent random `state`, `nonce` and a 43–128-character PKCE verifier in the app. Retain all three
   in the app's own expiring, single-use server-side login transaction, bound to that browser. Compute
   `base64url(SHA256(verifier))` without padding.
2. Redirect the browser to identity:

   ```text
   https://id.vibernt.ai/authorize?client_id=example-app&redirect_uri=URL_ENCODED_CALLBACK&response_type=code&scope=openid%20email&state=RANDOM_STATE&nonce=RANDOM_NONCE&code_challenge=S256_DIGEST&code_challenge_method=S256
   ```

   Identity uses its own 30-day host-only session. Otherwise it performs one of the client's configured email, GitHub or Google methods and resumes the
   request. `prompt=none` returns `login_required` if interaction is needed; the app decides whether to start a
   new interactive login. No cross-domain cookies are shared. Do not use third-party iframes for silent login.
3. At the callback, atomically consume the app's login transaction. Check exact `state` and the authorization
   response `iss=https://id.vibernt.ai` **before** exchanging the code. Handle `error` without creating a session.
4. POST to `/token` with `grant_type=authorization_code`, `code`, exact original `redirect_uri`, and `code_verifier`.
   Use HTTP Basic with form-encoded client id and secret for confidential clients; public clients send `client_id`.
   Do not forward the browser's cookies. Codes expire after 60 seconds and are single-use. Retry by starting a new
   authorization if the exchange result is lost; code replay is never successful.
5. Verify the ID token cryptographically using JWKS, allowing **only ES256** with an EC P-256 public signing key
   matching `kid`. Do not trust unverified header algorithms or follow a token-supplied key URL. Check `iss`, `aud`,
   `azp`, `exp`, `iat` with bounded clock skew, and your exact stored `nonce`. Reject unknown/malformed claims.
   Cache keys, and refresh once on unknown kid against the fixed issuer JWKS URL; a long cache alone is insufficient
   for one-hour key prepublication. Validation failures do not create app sessions.
6. Upsert the app's local principal projection keyed by `sub` (for Assay, the unchanged principal id), apply its
   own workspace admission/role policy, then create the app's host-only session and CSRF token. Identity's email
   invitation means “may establish identity”, not “may create or access a workspace”.

Access tokens last ten minutes and are only for `GET /userinfo` or `POST /userinfo`, via `Authorization: Bearer …`. ID tokens are not
accepted as UserInfo credentials. Human app grants have no refresh tokens; apps retain local sessions and use top-level identity
redirects when another authentication is needed. Existing local app sessions should continue during identity outages.

## Invite a person

After the app's own authorization approves an invitation, call `POST /v1/invitations` with Basic credentials,
`Content-Type: application/json`, and `{ "email": "member@example.com" }`. A 201 response has `accepted:true` and
an `expires_at` epoch-millisecond timestamp 30 days ahead. Repeating updates the expiry. The client identity comes
from authenticated credentials, not a caller-selected client. Invitations are scoped to that client and normalized
email. This call registers admission; it does not send mail or grant workspace membership.

## Sign out

An app session minted from an identity sign-in must expire within 30 days of that sign-in; Assay uses seven days.
Identity retains the client/subject/session association for 30 days after creation and sends back-channel logout
only for unexpired associations. Renewing a local session alone does not extend that association. Require a new
identity sign-in before minting a session that would exceed the 30-day limit.

Delete the app's own session under its own CSRF policy first. Redirect the browser to:

```text
https://id.vibernt.ai/logout?client_id=example-app&post_logout_redirect_uri=URL_ENCODED_REGISTERED_URI&state=APP_LOGOUT_STATE
```

Identity validates the return URI and asks for explicit CSRF-protected confirmation before deleting its own session.
Validate your returned logout state. You can also pass `id_token_hint`; it must be signed by this issuer and match the client and current session.
Other apps' human sessions are unaffected until M4 back-channel logout delivery. Do not advertise global sign-out yet.

## Required app-side tests before Assay switches

Wrong/missing state, replayed callback transaction/code, swapped nonce, wrong issuer/audience/azp, expired token,
`alg=none`/HS256 substitution, untrusted key URL, unknown kid refresh, client-secret failure, blocked/deleted account,
no-admission page, agent-connect approval continuation, local logout/CSRF and identity outage with an existing app
session. The server suite does not substitute for these tests in Assay or for OpenID conformance.

## Worker app using the client

Install the workspace package or vendor `dist/imprim-client.mjs`. Keep `clientSecret` in a Worker secret, never in browser JavaScript. The app owns its login transaction, cookie, local session, admission and CSRF checks.

```js
import { createClient, IdentityError } from 'imprim-client';

const client = createClient({
  issuer: 'https://id.vibernt.ai', clientId: 'example-app',
  clientSecret: env.IDENTITY_CLIENT_SECRET,
  redirectUri: 'https://app.example/auth/identity/callback'
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

`client.logoutUrl({idTokenHint,postLogoutRedirectUri,state})` produces the identity confirmation URL; end the local session under app CSRF first. `client.inviteEmail(email)` requires a confidential client and registers identity admission only. `handleBackchannelLogout(request)` verifies a signed logout token and returns `{sub,sid,jti}`; the app must persist consumed `jti` values, apply each event only once, and acknowledge duplicates with 2xx. Human back-channel logout is delivered through the durable M4 outbox; agent revocation events use the distinct contract below. Return 2xx for authenticated duplicate deliveries after durable deduplication.

Run `node scripts/build-client.mjs` to regenerate the single-file vendored artifact. Its first line records package version and SHA-256 of the remaining exact UTF-8 body. Assay should verify both before accepting a copy.

## Agent access (M2)

App clients and agent clients are separate registries. `/register` creates only a public **agent**; it cannot create an
app, register a resource prefix, change admission, or obtain client credentials. Registration alone grants nothing.
An operator configures agent access on the owning app through the existing offline seed/review process. Migration
`0004_agent_access.sql` leaves every existing app off. Add these settings to the client JSON:

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

The resource must name one workspace, for example `https://app.example/w/team-one/mcp`. Identity validates registered
ownership, not membership in that workspace. The resource server must intersect scopes with the person's current
membership and role **on every request**. Its expected audience comes from its own route/configuration, never a
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
approval; S256 applies to the authorization-code flow, not RFC 8628 polling. `/account` lists and revokes grants.

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

## Client 0.3.0 changes (wire change)

- Agent revocation events are RFC 8417 security events: `typ=secevent+jwt`, event type `<issuer>/events/agent-revoked`.
  0.3.0 accepts only that form; 0.2.0 accepted `typ=JWT`. Delivery re-signs on every retry for 24 hours, so either
  deploy order converges, but upgrade apps and the server in the same window.
- `handleCallback` requires `iss` on the authorization response (RFC 9207), as discovery advertises.
- `IdentityError.message` is always the package's own text. A server's `error_description` is in `error.description`:
  untrusted, escape it before display.
- JWKS is refetched after 10 minutes; keys up to 24 hours old keep verifying only while identity is unreachable.
- A failed discovery is not cached.
- ID tokens carry `email` and `email_verified` only when you request the `email` scope (the default `startLogin` does).

## Client 0.2.0 back-channel adoption

Use `verifyBackchannel(form)` at the registered back-channel URI to accept both `logout_token` and
`revocation_token`. Persist the verified jti and effect atomically; return 2xx for authenticated duplicates.
Agent tokens now include `grant_id`; check a denial keyed by `(sub, aud, grant_id)` on every agent request.
Logout with no sid ends all local sessions for sub. The full handler, exact claim shapes, clock rules and
Assay/Touchstone upgrade steps are in the [package README](https://github.com/Vibernt/imprim/blob/main/packages/imprim-client/README.md).
