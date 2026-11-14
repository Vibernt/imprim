# Identity protocol (M1 sign-in, M2 agent access and M4 control plane)

Issuer: `https://id.vibernt.ai`. Native ESM Worker; zero runtime dependencies. Identity proves a human's identity;
apps retain workspace admission, memberships, roles, local sessions and API tokens. Imported Assay principal ids
remain `sub`. This implementation is not yet OpenID-certified; see the release gates in OPERATIONS.md.

## Endpoints

| Endpoint | Behavior |
|---|---|
| `GET /.well-known/openid-configuration` | Supported endpoints, code flow, ES256, S256, basic/public-client authentication. |
| `GET /.well-known/jwks.json` | Public EC P-256 signing keys only, `alg=ES256`, `use=sig`; five-minute HTTP cache. |
| `GET /authorize` | Exact registered client/redirect validation, then SSO or sign-in. |
| `POST /token` | Form-encoded authorization-code exchange; confidential clients use HTTP Basic. |
| `GET /userinfo` or `POST /userinfo` | Bearer opaque access token; `sub`, and email claims if `email` was authorized. |
| `GET /logout` | Validate client/return URI, show confirmation; no cookie-authenticated destructive GET. |
| `POST /logout` | Form-encoded same-origin CSRF confirmation; deletes identity session and associated tokens/codes. |
| `POST /v1/invitations` | JSON `{email}`, confidential client Basic authentication; upserts a 30-day invitation. |
| `POST /v1/auth/magic/request` | JSON `{email, request_id, turnstile}`; neutral `{accepted:true}` after browser/challenge checks. |
| `POST /v1/auth/magic/verify` | JSON `{token}`; explicit same-origin POST, browser-bound single use, resumes authorization. |
| `GET /v1/auth/github/start?request_id=…` | Browser-bound pending request, PKCE S256 GitHub OAuth start. |
| `GET /auth/github/callback` | Consumes hashed OAuth state, checks browser, exchanges code, links numeric GitHub id. |
| `GET /v1/auth/google/start?request_id=…` | Browser-bound pending request, Google OIDC code flow with S256, state and nonce. |
| `GET /login/google/callback` | Consumes Google state, verifies RS256 ID token with cached Google JWKS, links Google sub. |
| `GET /login` | Email fragment confirmation, or operator-only standalone email request with no client registered. |
| `GET /check-email`, `/signed-in`, `/signed-out`, `/error` | Minimal HTML; signed-in page requires a current identity session. |

The email-request UI loads Turnstile's script/frame only when both keys are configured. With neither key configured,
the email button works without a challenge for local/development use. Every HTML page has a strict CSP allowing only
same-origin assets and the Turnstile script/frame origin; no inline script is used. No production readiness is implied.

## Authorization

Required query parameters: `client_id`, `redirect_uri`, `response_type=code`, `scope` including `openid`, nonempty
`state`, nonempty `nonce`, `code_challenge` (43-character base64url SHA-256 digest), `code_challenge_method=S256`.
Supported scopes: `openid email profile` (no additional profile claims currently exist). Only query response mode.
`prompt=login` forces a new sign-in; `prompt=none` returns `login_required` to the trusted client if no valid session.
Unsupported request objects, `request_uri`, `claims`, `max_age`, and authorization `id_token_hint` are rejected.
Duplicate query/form parameters are rejected. State/nonce limit: 512 characters. Bodies: 16 KiB.

Redirects match the stored string exactly; no wildcard, username/password, fragment, whitespace, or backslash.
HTTPS is mandatory. A client with `dev=1` may register HTTP on `localhost`, `127.0.0.1`, or `[::1]` only, including
an exact port/path. The issuer itself always uses HTTPS and Secure `__Host-` cookies, including tests.

An unknown client or untrusted redirect produces a local error without redirecting. Errors after that boundary
return `error`, `state`, and `iss`. Success returns `code`, `state`, and `iss` (RFC 9207).
The pending authorization is valid for 30 minutes and bound to the hash of `__Host-vi_browser`. It is consumed
atomically with code insertion. A link opened in a different browser cannot complete or spend the original request.

## Token exchange and claims

`POST /token`, `Content-Type: application/x-www-form-urlencoded`:
`grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…`.
HTTP Basic credentials use URL-form-encoded client id and secret, joined by `:`, then standard base64.
Public clients have a NULL secret hash and send `client_id` without Authorization. Body secrets are refused.
Public clients cannot register invitations. Every client requires PKCE S256; verifier length is 43–128 characters.

Codes are random 256-bit opaque values stored only by SHA-256. Lifetime: 60 seconds. The atomic claim uses
`DELETE … RETURNING` bound to client, exact redirect, PKCE digest and expiry. A consumed-code tombstone is written
in the same D1 batch; a known replay is refused and audited. Wrong credentials or verifier do not consume a code.
Only a currently active user with an unexpired identity session, admitted to this client, can exchange a code.
A replayed code is refused, and the access token that code issued is deleted (RFC 9700 §4.2.4). The ID token it
issued cannot be recalled; it expires within 10 minutes. `/token` is limited per authenticated client (`client:<id>`
in `API_LIMITER`), not per address, because Worker-hosted apps share Cloudflare egress. Failed client
authentication spends the caller's address budget instead.

Success: `access_token`, `token_type=Bearer`, `expires_in=600`, `id_token`, `scope`, with `Cache-Control: no-store`.
The access token is independent random material, hash-stored in D1 for UserInfo only. It is not an app API token.
The signed ID token lasts 600 seconds and has `iss`, `aud` (client id), `azp` (same client id), `sub`, `iat`, `exp`,
`amr` (`["email"]`, `["github"]`, or `["google"]`), `auth_time` (Unix seconds), `sid`, and `nonce`. `email` and boolean
`email_verified` appear only when the request asked for the `email` scope (OIDC Core 5.4).
Only ES256 is emitted/advertised; private key material is never in JWKS. Human app grants have no refresh tokens; neither flow supports implicit grants. Agent refresh grants are described below.

## Sign-in and sessions

**Account page** (`/account`). A signed-in person manages:
- **Profile:** a display name, sent as `name` with the `profile` scope.
- **Email:** changing it needs proof at both ends. That is an email-link sign-in within ten minutes for the current
  address, then a single-use, browser-bound confirmation (a POST, not the link itself) from the new address. The old
  address is told at request and at change. An address another account in the realm holds is refused.
- **Security:** the password, factors and remembered browsers.
- **Sessions:** identity sessions show device, place and last use. Signing one or all others out sends back-channel
  logout.
- **Apps:** sign out of one app (back-channel logout).
- **Connected agents:** revoke any of them.
- **Deletion:** needs the typed email, a sign-in within ten minutes and, with a factor, a second factor within ten
  minutes. It ends identity and app sessions, revokes agent grants with revocation events, and removes every sign-in
  method.

**Security notices** go to the account's address for:
- a new device (one not seen in 90 days; never on the first sign-in);
- password, factor, recovery-code and email changes;
- a new connected agent;
- deletion;
- an admin MFA reset.

**Admin MFA reset** (`POST /admin/api/users/<id>/reset-mfa {reason}`) needs a fresh admin second factor and a reason.
It removes the person's factors, recovery codes and remembered browsers, and ends their sessions. The reason is
audited and the person is told by email.

**Two-factor authentication.** Each client sets `mfa`: `off`; `optional` (required once the person has added a
factor); or `required` (a person without a factor must enrol before the code is issued). A gate in front of every
code and every agent consent sends the browser to `/mfa?request_id=…` (enter a code) or `/account/mfa?request_id=…`
(enrol), and then continues the authorization. Factors: TOTP authenticator apps (RFC 6238: SHA-1, six digits,
30-second steps, one step of drift; each step is accepted once; secrets are sealed with `SEALING_KEY`), and ten
single-use recovery codes (shown once, stored as SHA-256). Ten wrong codes within 15 minutes lock the factor, and
attempts are counted before they are checked, so a parallel burst cannot pass the limit. A client may let a
**trusted browser** skip the second factor for `mfa_trusted_device_days` (1–90, default 0 = never). Trusted browsers
are forgotten when a password or factor changes. **Step-up:** `acr_values=urn:imprim:acr:mfa` demands a second
factor in this session, and a trusted browser does not count. `max_age` (seconds) treats an older primary sign-in as
none, and also bounds the age of the second factor. The ID token carries `acr` (`urn:imprim:acr:mfa` after a second
factor, otherwise `urn:imprim:acr:sf`) and `amr` gains `otp` and `mfa`. Under `prompt=none`, a needed second factor
returns `error=interaction_required`. **Agents:** `agent_consent_mfa: required` needs a second factor within 15
minutes before approval. **Administrators** always need a second factor, verified within the hour; the console sends
them to enrol or verify. Adding a factor needs a sign-in within ten minutes. Removing one, or replacing the recovery
codes, needs a second factor within ten minutes. Each change is audited and emailed to the account.

**Passwords** (client method `password`). A first password is set only within ten minutes of an email link (fresh mailbox proof). New
people choose "Email me a link to set one": an email link with `purpose: "password"` proves the mailbox and opens
`/account/password`, and saving continues the original authorization as a password sign-in (`amr: ["pwd"]`).
`POST /v1/auth/password {request_id, email, password, turnstile}` needs Origin, the browser binding and a pending
request for a client that offers `password`; administrators never use it. An unknown email, an account without a
password and a wrong password all return `401 invalid_grant` "Email or password is incorrect.", after the same key
derivation. Ten failures for one address lock that address (known or not) for 15 minutes from the tenth (`429`); attempts
are counted before the password is checked. Hashes are PBKDF2-SHA256 with 100,000 iterations (the Workers maximum), a 16-byte salt and NFKC
normalisation, with algorithm and parameters stored per hash and upgraded at sign-in. New passwords need 12 to 128
characters, cannot be the email, and are checked against Have I Been Pwned's range API (only a five-character
SHA-1 prefix leaves the Worker); if that API is unavailable the password is refused (`503
breach_check_unavailable`). Changing a password needs the current one unless the session came from an email link
in the last ten minutes. Setting or changing a password signs out every other session, including its apps by back-channel logout, forgets
trusted browsers, and emails a notice. Proof
of the mailbox for an unverified account removes any password, with its provider links. A password is not mailbox
proof, so `allowed_domains` does not admit by it.

Email links live 15 minutes. The token appears only in `/login#token=…`, is removed from history by page script,
and is sent only after a Sign in click. Link prefetch GETs cannot consume it. Verification checks Origin, browser
binding, single use, current account state and current admission; invitation expiry/revocation applies at verification.
`browser_response:true` makes verification return `{redirect}` plus session cookies instead of a 303, allowing the
page to navigate without fetch following a cross-origin redirect.

Admission is per (user, client), recorded in `client_admissions`. A user is admitted to a client when they already
reached it, or when that client's own policy admits them: `open` signup; a current invitation for the exact email;
or an `allowed_domains` match proven by the mailbox. Only an email link, or Google with a signed `hd` equal to the
email's domain (or a `gmail.com` address), proves the mailbox. A GitHub or other provider "verified" flag never
satisfies a domain rule. An account that exists for another app is **not** admitted by existing, and the check
applies again on SSO, at agent consent and in the `/token` transaction. A refused SSO returns `error=access_denied`
to the client's redirect URI, including under `prompt=none`.
Open clients allow new verified users. Blocked/deleted/merged users always fail. Invitations do not grant app access.
An admin in the realm's D1 roster can sign in by email at `/login` before any RP is registered. Standalone login is
restricted to that roster; entries are compared case-insensitively. GitHub and Google cannot authenticate administrator
emails, either the provider email or an existing linked account email.

GitHub's stable numeric id is the identity key, not login/email. First linking uses only a verified primary email;
a linked numeric id retains its original user after a provider email change to an unclaimed address. A verified
email belonging to a different live/blocked user, or a tombstone merged elsewhere, is refused; a tombstone
merged into the linked user (or deleted without a merge target) is not a conflict; a provider identity is never reassigned. Provider access tokens are neither
stored nor logged. OAuth state lasts ten minutes, is hashed, browser nonce bound, and consumed before network I/O.

Each client's `sign_in_methods` is an ordered, nonempty list of distinct `email`, `github`, and/or `google`.
Only those controls appear on its pending sign-in page; one method is offered directly. Method checks run at magic
request and verification, each provider start and callback, authorization completion and code exchange. Existing
SSO sessions must use an allowed method; otherwise interactive authorization shows the allowed methods and
`prompt=none` returns `login_required`. A policy change never silently substitutes another method.

Google uses the fixed authorization/token/JWKS endpoints in [Google's discovery metadata](https://accounts.google.com/.well-known/openid-configuration).
The upstream callback is `/login/google/callback`. State is hashed, provider-scoped, valid for ten minutes, bound to
`__Host-vi_google` and the pending request's browser cookie, and consumed with `DELETE … RETURNING` before network
I/O. An independent nonce is retained with the PKCE verifier. Codes, ID tokens, access tokens and client secrets
are never persisted or logged. Provider exchanges and JWKS fetches occur outside database transactions.

Only RS256 with a matching RSA signing key from Google's fixed JWKS endpoint is accepted; token-supplied key URLs
and other algorithms are refused. Public JWKS data is cached per Worker environment using provider max-age/Age,
capped at 24 hours; no-cache/no-store or absent max-age means no retention. Unknown kid refreshes once. Expired
keys or failed fetches cause failure, never stale-key or alternate-provider acceptance. JSON responses are bounded
to 64 KiB and fetches have a ten-second timeout.

Validation requires a valid signature, issuer `https://accounts.google.com` or `accounts.google.com`, exact scalar
audience `GOOGLE_CLIENT_ID`, matching `azp` if supplied, unexpired integer `exp`, exact nonce, nonempty `sub`, and
boolean `email_verified=true`. `google_hosted_domains`, when nonempty, matches the signed `hd` claim exactly; an
email suffix or authorization URL hint is insufficient. The verified `hd` is stored on the session and checked
again for SSO and code exchange. Policy is reread after provider network I/O, before linking and session issuance.

Google identities use `(provider='google', provider_id=sub)`. A new Google subject links to an existing user with
the same email only when Google is authoritative for that mailbox (signed `hd` equal to the domain, or `gmail.com`),
or when the same browser already holds a session for that user. GitHub never auto-links by email: a person with an
existing account signs in by email link first, then continues with GitHub in the same browser. Linking never changes
the subject; an established Google subject retains its owner across unclaimed email changes. Conflicts with an
existing email owner, concurrent links to someone else, and blocked/deleted/merged accounts fail without a session.
First sign-in follows the same invited/open policy as email and GitHub; refused admission returns the neutral
`Account unavailable.` error and creates no session. See [Google's validation guidance](https://developers.google.com/identity/openid-connect/openid-connect).

Session token and CSRF token are random and hash-stored. Cookies: `__Host-vi_session` (HttpOnly) and `__Host-vi_csrf`
(JS-readable), Secure, Path=/, SameSite=Lax, 30 days, no Domain. Mutations using the identity session require exact
Origin and matching cookie/submitted CSRF value, checked against the stored digest. No localhost insecure-cookie mode.
Rate limit bindings fail explicitly when missing or failing. Per-email/IP D1 limits are an additional budget.
Configured Turnstile validates success, hostname, action `sign_in`, and records accepted tokens against replay.
Siteverify outages enter an audited existing-user-only mode with stricter rate limits; new sign-ups remain blocked.
Invalid challenges and secret errors fail. Request delivery failures are audited; the public
magic request remains neutral and does not claim delivery.

## Logout and errors

RP logout uses `client_id` and/or a verified `id_token_hint`, optional exact `post_logout_redirect_uri`, and optional `state`. With a session, GET
renders a confirmation form carrying CSRF; POST checks Origin + double submit and deletes the identity session.
The registered URI is checked again at POST. Without a session GET may redirect to the registered URI. An `id_token_hint` must have an ES256 signature from this issuer's local ring, matching issuer/client claims and
(current browser, if present) subject/sid. An expired hint is accepted only for its still-active browser session. No third-party logout URL is accepted without a registered client.
Human logout captures durable app-session associations and sends signed OIDC back-channel logout through the queue.
An association expires 30 days after it was created, matching the identity-session lifetime. Token exchange records
the association once per client, subject and identity-session sid; later exchanges do not extend its expiry. Scheduled
maintenance deletes at most 500 expired associations per run. Block, delete, logout and merge capture only unexpired
associations, even if maintenance has not removed expired rows yet. Apps must end any session minted from identity
sign-in within 30 days of that sign-in (Assay uses seven days). An app that needs a longer session must obtain a new
identity sign-in and create a new association.
The form field is `logout_token`, with ES256 header `typ=logout+jwt` and claims `iss`, scalar app `aud`, `sub`, `sid`
when scoped to one session, integer `iat`, `exp=iat+120`, stable event `jti`, and exactly
`events:{"http://schemas.openid.net/event/backchannel-logout":{}}`; never `nonce`. One event is sent per affected client.
Account-wide actions covering multiple sessions of one client omit `sid` to end all sessions for that subject.
Admin session revocation uses the same session-scoped path; merge logs out the disappearing subject and also the
survivor, preserving M4's explicit reauthentication requirement.
Block/delete capture all associations and revoke all grants atomically. Agent revocations use the separate event below.
Both back-channel event types stop retrying 24 hours after outbox creation. The dispatcher marks them expired;
the consumer acknowledges a late queue message without signing or delivery. `iat` remains the delivery time.
Receivers must retain replay `jti` values for at least 24 hours plus the token lifetime and permitted clock skew
(120 seconds for logout tokens, 300 seconds for agent revocation tokens, plus the receiver's skew).
See [Control plane](CONTROL_PLANE.md) for admin authentication, API, delivery and rotation contracts.

JSON errors have `error` and `error_description`; browser GET errors may render HTML. OAuth errors include
`invalid_request`, `invalid_client`, `invalid_grant`, `invalid_scope`, `unsupported_response_type`,
`unsupported_grant_type`, `login_required`, `access_denied`, and `invalid_token`. Invalid client authentication is
401 with a Basic challenge; invalid UserInfo authentication is 401 with a Bearer challenge. Boundary errors include
`origin`, `csrf`, `browser_binding`, `turnstile_*`, `rate_limit`, and configuration errors. Unexpected failures are
500 `server_error` without internal details. Failed dependencies are not replaced by alternate providers.

## Agent authorization (M2)

This implements the [MCP authorization profile](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html), [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591.html),
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html), [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html),
and [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html). App authorization above remains OIDC; the following
rules apply to the separate public-agent registry and OAuth grants.

| Endpoint | Behavior |
|---|---|
| `GET /.well-known/oauth-authorization-server` | Same issuer/endpoints as OIDC discovery; advertises S256, device/registration endpoints, refresh/device grants and `client_id_metadata_document_supported:true`. |
| `POST /register` | Public-only RFC 7591 JSON metadata; 201 registration response, no secret. Ten attempts/IP/hour plus existing API binding. |
| `GET /authorize` | Metadata-URL or dynamic agent ID, S256, state and one resource; sign in through the owning app, then explicit consent. |
| `GET /agent/consent` | Browser-bound request + signed-in session; escaped agent name/host (or unverified), app, workspace, resource, scope descriptions and grant cap. |
| `POST /agent/consent` | Same Origin and session CSRF; atomic single-use approval/denial. |
| `POST /device_authorization` | Form-encoded public client/resource/scopes; device secret, human code, verification URLs, ten-minute expiry, five-second interval. |
| `GET /device` | Code-entry form; matching live code starts app sign-in, then the same consent page. GET never grants access. |
| `POST /token` | Code + S256 verifier, refresh token, or device code; exact client and resource required on every exchange. |
| `GET /account` | Current person's grants, including creation/last-use times and revoked/expired status. |
| `POST /account/revoke` | Same Origin + CSRF + grant ownership; durable revocation and back-channel outbox. |

Agent IDs do not replace imported subjects. `auth_requests.client_id` remains the owning app for sign-in/admission;
separate columns bind the agent, resource and optional device. The resource must be a canonical HTTPS URL without
query/fragment, encoded slash, backslash or dot, percent-encoded unreserved characters, lowercase escapes, empty
segments or a trailing slash, so one route has exactly one audience (prefixes may end in `/`); one app must own its complete path prefix. A second resource is
rejected, including duplicate parameters. The stored resource cannot change during code exchange or refresh. The
workspace label is the decoded `/w/<workspace>` segment where present, otherwise the resource path is displayed.
Apps remain responsible for workspace membership and current authorization.

Agent redirect registration permits exact HTTPS or HTTP loopback on `127.0.0.1`, `[::1]`, and `localhost`. Only the
loopback port may vary at authorization; token redemption requires the exact requested URI. Codes are 256-bit random,
SHA-256 stored, valid for 60 seconds and atomically consumed. Invalid client/resource/redirect/verifier cannot spend
a valid code. Agent requests always require explicit consent; SSO only skips sign-in, and no ID token is issued.
All agent pages use the existing strict CSP, escaped text, same-origin form actions and no inline scripts.

### Client metadata and outbound boundary

Client-ID documents require an exact self-identifying `client_id`, nonempty `client_name`, and nonempty
`redirect_uris`. Bidirectional-override, zero-width and control characters are removed from `client_name`; a name
that is empty afterwards is refused. Code response types and the supported grant types are accepted. **Without
`grant_types`, a document gets `authorization_code` and `refresh_token` only**; the device grant must be declared.
`token_endpoint_auth_method` is `none` (the default) or `private_key_jwt` with exactly one of `jwks` (public P-256 or
RSA-2048+ keys, each with `kid`) or `jwks_uri` on the client ID's own host. A key-bound agent must send a
`client_assertion` (RFC 7523: ES256 or RS256, `iss`=`sub`=client ID, `aud` the issuer or the endpoint URL, `exp` at
most five minutes ahead, single-use `jti`) to `/device_authorization` and to every `/token` request. Dynamic
registration cannot use keys. The client ID URL must use port 443. Documents
must be `application/json`. Each fetch has one five-second deadline spanning DNS, HTTPS and streamed body reads;
DNS and document bodies each have a 64 KiB ceiling. HTTPS only; redirects are rejected rather than followed.
Literal private, loopback, link-local, mapped IPv4, multicast and other special-purpose addresses are refused.
Local hostnames are refused. Both A and AAAA answers from the fixed Cloudflare DNS-over-HTTPS resolver must contain
only public addresses; an error, missing addresses or a mixed public/private answer fails closed.

The subsequent HTTPS call uses **Workers global fetch**, not a private/VPC/service binding. DNS checking is not IP
pinning: rebinding protection also depends on the deployed Workers public-network egress boundary. These modules
are not a general-purpose Node SSRF transport. Deployment must qualify that boundary; local fake DNS/fetch tests
cannot prove it. No alternate DNS resolver, stale document or automatic registration fallback is used on failure.

HTTP `max-age` or `Expires` controls the D1 metadata cache; subtract `Age` and apparent age from `Date`, cap retention
at one hour and cache size at 2,000 entries (documents and agent JWKS). Every document is kept for at least five
minutes, including one marked `no-store`, so a refresh loop cannot turn the fetcher into a traffic source.
Anonymous `/authorize` requests for agents spend a 60-per-hour address budget. Expired fetch failures never serve stale data. Documents are not app-policy caches: app settings
are reread at every stage. DCR clients unused for 30 days are rejected immediately and removed by registration/
every-minute maintenance; completed consent and token use update their last-use time. Grants and audit history survive.

### Agent tokens, rotation and revocation

Access JWTs use the existing sealed ES256 ring, `typ=at+jwt`, with `iss`, scalar `aud=resource`, unchanged human `sub`,
agent `client_id`, nonempty `grant_id` (the grant to deny on revocation), space-separated `scope`, random `jti`, integer `iat` and `exp`. Lifetime is 60 seconds, shortened
at the grant deadline. No access token or raw refresh token is stored. Refresh tokens are 256-bit random and stored
as SHA-256 digests; spent hashes and their replacement digest remain to detect replay. Grant lifetime defaults to
90 days and is capped by the owning app. A policy increase cannot extend existing consent; a reduction applies to
future exchanges. Logout does not revoke an agent grant: use Connected agents. Blocking/deleting/merging the person
stops new exchanges and durably revokes grants; already issued JWTs expire within 60 seconds without positive expiration leeway. Access-token verification permits bounded future `iat`/`nbf` skew
(default 60 seconds, configurable integer 0–60); it never extends `exp`.

Rotation atomically marks the old refresh hash spent and inserts its replacement. A retry with a token spent less
than 10 seconds ago, whose replacement has not been used, rotates that replacement instead (a lost response is
not fatal). The replacement is then spent, so whoever holds it trips reuse detection; a grace rotation never earns
a second grace. Any other use of a spent token revokes the entire grant. `scope` on refresh may narrow the access
token to a subset; the refresh token keeps the grant's scope. Each grant has a budget of 3,000 refreshes a day.
An agent code used twice revokes the grant it created. Wrong client or resource cannot spend or revoke another grant.
A correctly bound spent refresh token revokes the grant even if current app policy is off. Code/device redemption
and refresh transactions also fence changes to the validated app policy and the person's active status. No network
calls occur inside D1 batches. Failed signing or metadata dependencies never return invented tokens.

Audit events include `agent_grant`, `agent_token`, `agent_revoke`, `agent_refresh_reuse` and `agent_code_replay`.
A refresh only updates `last_used`; it writes no audit row. Neither raw credentials nor provider secrets enter audit records. Revocation,
its audit event and a durable outbox event are one transaction. The outbox row is written even when the app has no
`backchannel_uri`, so the loss is reported as `missing_uri`. The request queues only its own new event, after the
response, in `waitUntil`; a queue failure leaves revocation effective and the event pending for the every-minute
dispatcher, and the person never sees an error.

The queue consumer sends form-encoded `revocation_token`, a signed ES256 security event token (RFC 8417,
`typ=secevent+jwt`) containing issuer, app ID `aud`, person's `sub`, stable event `jti`, five-minute `iat`/`exp`,
`grant_id`, exact `resource`, and `events: {"<issuer>/events/agent-revoked": {}}`. The event type is relative to the
issuer, so each realm names its own events; for `https://id.vibernt.ai` it is unchanged. Client 0.3.0 accepts only
this form; 0.2.0 accepted `typ=JWT`. The receiver verifies signature/issuer/audience/event/
time and deduplicates `jti`; 2xx acknowledges receipt. Delivery uses a ten-second deadline and refuses redirects;
failures retry until the 24-hour creation bound and may reach the configured DLQ. Delivery is at least once within that bound. This event is not an OIDC logout
token and does not end all of the person's app sessions. Human back-channel logout uses a separate durable outbox and the same queue; see CONTROL_PLANE.md.

### Device state machine

A random device secret and eight-character human code (shown in two groups) are stored only as hashes. Issuance and
human-code lookup each have separate 20/IP/hour budgets in addition to the API limiter. User-code verification starts
a fresh browser-bound request; it never exposes the device secret. A person must sign in through the owning app and
approve or deny with session CSRF. Multiple browsers cannot approve the same device twice.

Before approval, a correctly spaced poll returns `authorization_pending`. Polling too early atomically increases
the stored interval by five seconds and returns `slow_down`; that increase persists. Denial returns `access_denied`;
expiry returns `expired_token`. Approved codes redeem once to the same access/refresh pair as browser grants.
Expired device rows remain one day for expiry responses, then maintenance removes them. Unknown/consumed codes
return `invalid_grant`. Policy, user status and resource binding are checked again before credentials are issued.

## Control plane (M4)

See [Control plane](CONTROL_PLANE.md) for all `/admin` and `/admin/api/*` routes, scoped magic-link sessions,
CSRF/Origin enforcement, destructive reauthentication, transactional audit, block/merge/delete behavior and key rotation.
