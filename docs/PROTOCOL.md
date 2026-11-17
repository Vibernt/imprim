# Protocol

Every route below is served on each realm's issuer, for example `https://id.example.com`. Imprim proves a person's
identity; apps keep workspace admission, memberships, roles, local sessions and API tokens. Users imported with
`scripts/import-users.mjs` keep their ids as `sub`. Imprim is not yet OpenID-certified; see the
[release gates](OPERATIONS.md#release-gates).

## Endpoints

| Endpoint | Behavior |
|---|---|
| `GET /.well-known/openid-configuration` | Supported endpoints, code flow, ES256, S256, basic/post/public-client authentication. |
| `GET /.well-known/jwks.json` | Public EC P-256 signing keys only, `alg=ES256`, `use=sig`; five-minute HTTP cache. |
| `GET /authorize` or `POST /authorize` | Exact registered client/redirect validation, then SSO or sign-in. POST takes a form body. |
| `POST /token` | Form-encoded authorization-code exchange; confidential clients use HTTP Basic or `client_secret_post`. |
| `GET /userinfo` or `POST /userinfo` | Bearer opaque access token in the header, or as `access_token` in a POST form body (RFC 6750 §2.2), never both and never in the query; `sub`, and email claims if `email` was authorized. |
| `GET /logout` | Validate client/return URI, show confirmation; no cookie-authenticated destructive GET. With no `client_id` it is a person signing out from Imprim's own pages: no return URI or state is accepted, and it ends at `/signed-out`. |
| `POST /logout` | Form-encoded same-origin CSRF confirmation; deletes identity session and associated tokens/codes. |
| `POST /v1/invitations` | JSON `{email}`, confidential client Basic authentication; upserts a 30-day invitation. |
| `POST /v1/auth/magic/request` | JSON `{email, request_id, turnstile}`; neutral `{accepted:true}` after browser/challenge checks. |
| `POST /v1/auth/magic/verify` | JSON `{token}`; explicit same-origin POST, browser-bound single use, resumes authorization. |
| `GET /v1/auth/github/start?request_id=…` | Browser-bound pending request, PKCE S256 GitHub OAuth start. |
| `GET /auth/github/callback` | Consumes hashed OAuth state, checks browser, exchanges code, links numeric GitHub id. |
| `GET /v1/auth/google/start?request_id=…` | Browser-bound pending request, Google OIDC code flow with S256, state and nonce. |
| `GET /login/google/callback` | Consumes Google state, verifies RS256 ID token with cached Google JWKS, links Google sub. |
| `GET /v1/auth/provider/<id>/start?request_id=…` | Registry provider (OIDC, Microsoft, Apple) start: PKCE S256, state and nonce. |
| `GET`/`POST /login/provider/<id>/callback` | Registry provider callback; Apple's `form_post` is answered with a 303 to the same URL as a GET. |
| `POST /v1/auth/password` | JSON `{request_id, email, password, turnstile}`; password sign-in (below). |
| `POST /v1/auth/passkey/options`, `/v1/auth/passkey/verify` | Passkey sign-in ceremony (below). |
| `GET`/`POST /mfa` | Second-factor challenge for a pending authorization, agent consent or the console. The page asks for the 6-digit authenticator code in one-time-code boxes; `?recovery=1` shows a field for a recovery code instead. The POST accepts either in `code`. |
| `GET /login` | Email fragment confirmation, or a standalone email request restricted to the realm's admin roster. |
| `GET /check-email`, `/signed-in`, `/signed-out`, `/error` | Minimal HTML; the signed-in page requires a current identity session. |
| `GET /account`, `/account/security`, `/account/sessions`, `/account/agents`, `/account/password`, `/account/mfa`, `/account/email/confirm` | The account pages: profile, security, sessions and apps, connected agents, and the password, factor and email-change pages (below). |
| `POST /account/{profile,sessions,apps,devices,email,email/confirm,delete,password,mfa,revoke}` | Account changes; same Origin and CSRF. |
| `POST /account/passkeys/{options,register,remove}` | Passkey registration and removal. |
| `GET /assets/local.css`, `/assets/sign-in.js`, `/assets/passkey.js` | Imprim's stopgap CSS (empty unless Fire lacks something; pages link it only when it has rules, with a hash of its content as `?v=`) and its two page scripts; one-hour cache. |
| `GET /assets/theme.css[?client=id]` | The brand's Fire look as `<html>`-level custom properties for the realm, or an app in it; five-minute cache ([Branding](BRANDING.md)). |
| `GET /assets/brand/<sha256>` | An uploaded logo or mark of this realm, sandboxed (`CSP: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `nosniff`); 404 otherwise. |
| `GET /fire/*`, `/imprim/*` | Static assets (Fire, and the console's branding editor module), served before the Worker with `nosniff` and `Cross-Origin-Resource-Policy: same-origin`. |

Pages use no inline script or style. Every HTML page sends `default-src 'self'; script-src 'self'; frame-src 'none';
style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri
'none'`. `form-action` also names the origin a page's form redirects to (an app's post-logout URI, an agent's
callback). The sign-in page adds Turnstile's origin to `script-src` and `frame-src` only when both Turnstile keys
are configured; with neither, the email button works without a challenge for development. Console pages use a
stricter policy ([Control plane](CONTROL_PLANE.md#authentication-and-routes)).

## Authorization

`GET /authorize` with query parameters, or `POST /authorize` with the same parameters as a form body (OIDC Core
3.1.2.1). Agents use GET only.

Required parameters: `client_id`, `redirect_uri`, `response_type=code`, `scope` including `openid`, nonempty
`state`, nonempty `nonce`, `code_challenge` (43-character base64url SHA-256 digest), `code_challenge_method=S256`.
Supported scopes: `openid email profile` (`profile` adds `name`). Only the `query` response mode is accepted.
`prompt=login` forces a new sign-in; `prompt=none` returns `login_required` to the trusted client if no valid session.
`max_age` (whole seconds) and `acr_values` are accepted (see Two-factor authentication). Request objects are refused
with `request_not_supported` and `request_uri` with `request_uri_not_supported`; `claims` is refused with
`invalid_request` unless the app uses classic OpenID Connect (below). `ui_locales` (space-separated BCP 47 tags)
sets the language of the pages that follow and of the sign-in email; malformed or unknown tags are ignored, never an
error, and at most 10 are kept with the request. Discovery lists the realm's languages as `ui_locales_supported`
([Languages](TRANSLATING.md)). Agent authorization accepts it too.

`id_token_hint` is an ID token this issuer gave this app, verified against the local ring; it may have expired. It
names the person the app expects: a session belonging to anyone else counts as no session (`prompt=none` returns
`login_required`), and the request records the hinted person, so nobody else can finish it. A hint that is forged,
malformed or issued to another app is refused with `invalid_request`.

**Classic OpenID Connect** (client setting `classic_oidc`, `off` by default, confidential apps only) accepts requests
from libraries written before OAuth 2.1: `code_challenge`/`code_challenge_method` and `nonce` may be left out, and a
`claims` request is ignored, as OIDC Core 5.5 allows. A request that sends one PKCE parameter must send both, and its
code then needs the verifier. A code issued without a challenge refuses a verifier, so PKCE cannot be half used. An
ID token for a request without a nonce carries none. Public clients always need PKCE, whatever the setting.

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
HTTP Basic credentials use URL-form-encoded client id and secret, joined by `:`, then standard base64. At `/token`
only, `client_secret_post` (`client_id` and `client_secret` in the body) is accepted too; a request that uses both is
refused. Other endpoints refuse body secrets.
Public clients have a NULL secret hash and send `client_id` without Authorization.
Public clients cannot register invitations. Every client sends a PKCE S256 verifier of 43–128 characters, except a
classic OpenID Connect app whose request had no challenge, which must send none.

Codes are random 256-bit opaque values stored only by SHA-256. Lifetime: 60 seconds. The atomic claim uses
`DELETE … RETURNING` bound to client, exact redirect, PKCE digest (empty for a classic request without one) and expiry. A consumed-code tombstone is written
in the same D1 batch; a known replay is refused and audited. Wrong credentials or verifier do not consume a code.
Only a currently active user with an unexpired identity session, admitted to this client, can exchange a code.
A replayed code is refused, and the access token that code issued is deleted (RFC 9700 §4.2.4). The ID token it
issued cannot be recalled; it expires within 10 minutes. `/token` is limited per authenticated client (`client:<id>`
in `API_LIMITER`), not per address, because Worker-hosted apps share Cloudflare egress. Failed client
authentication spends the caller's address budget instead.

Success: `access_token`, `token_type=Bearer`, `expires_in=600`, `id_token`, `scope`, with `Cache-Control: no-store`.
The access token is independent random material, hash-stored in D1 for UserInfo only. It is not an app API token.
The signed ID token lasts 600 seconds and has `iss`, `aud` (client id), `azp` (same client id), `sub`, `iat`, `exp`,
`amr` (the method: `email`, `pwd`, `github`, `google` or a provider id; a passkey gives `hwk` or `swk` with `user`;
a second factor adds `otp` and `mfa`), `acr`, `auth_time` (Unix seconds), `sid`, and `nonce` when the request had one. `name` appears with the
`profile` scope when the person has set one. `email` and boolean
`email_verified` appear only when the request asked for the `email` scope (OIDC Core 5.4).
Only ES256 is emitted/advertised; private key material is never in JWKS. Human app grants have no refresh tokens; neither flow supports implicit grants. Agent refresh grants are described below.

## Sign-in and sessions

**Registry providers** (realm config `providers.<id>` of type `oidc`, `microsoft` or `apple`; client method `<id>`).
- **Flow:** the authorization code flow with PKCE S256, `state`, `nonce` and a browser-bound cookie. The state is
  single-use and provider-scoped.
- **Discovery:** it must name the configured issuer (for Microsoft, a `{tenantid}` template). It is cached for an
  hour per isolate.
- **ID token checks:**
  - RS256 or ES256 only, from the provider's JWKS (refreshed once for an unknown `kid`);
  - exact issuer (Microsoft: the token's `tid`; a pinned tenant must match) and audience (`azp` if more than one);
  - nonce, expiry and a subject;
  - a verified email (`email_verified` true; Microsoft has no such claim, so its email is accepted as a provider
    claim).
- **Email trust:** mailbox proof only where the provider lists the domain in `trusted_domains`, with a pinned tenant
  for Microsoft. Otherwise there is no auto-link to an existing account, and a new account is unverified until its
  first email link.
- **Apple:** `form_post`, a `SameSite=None` state cookie, and a client secret signed with the team key.

**Passkeys** (WebAuthn Level 2; client method `passkey`). The relying-party ID is the realm's host, and the origin
must equal the issuer. Credentials are discoverable and need user verification (a PIN or biometric).
- **Algorithms:** ES256, Ed25519 and RS256. Attestation is `none`, so Imprim claims nothing about the authenticator's
  make.
- **Challenges:** 256-bit, single-use, bound to the browser and to their purpose (register, sign-in, second factor),
  valid for five minutes.
- **Signature counter:** it must move forward atomically, so a cloned hardware key is refused. Synced passkeys
  report zero, so they get no clone detection. Replay is stopped by the single-use challenge.
- **Strict parsing:** attestation must be `none` with an empty statement, and extensions must parse. No trailing
  bytes are allowed, backup state without eligibility is refused, and EC and Ed25519 keys must be 32 bytes. Sign-in
  needs `userHandle`.
- **Recovery codes:** the first factor of any kind comes with them; removing the last factor voids them.
- **Sign-in:** a passkey sign-in counts as multi-factor: `amr` is `hwk` (or `swk` for a synced passkey), `user` and
  `mfa`, and `acr` is MFA. Administrators sign in by email link and use passkeys only as their second factor.
- **Second factor:** at `/mfa`, a passkey sits beside authenticator apps.
- **Adding and removing:** adding one follows the rule for any factor (a fresh sign-in, or a fresh second factor when
  one exists). Removing one needs a fresh second factor. Each change is audited and emailed.

**Account pages** (`/account`, `/account/security`, `/account/sessions`, `/account/agents`). A signed-out visit to `/account…` or `/mfa` gets a 401 page explaining that
the account opens from an app's sign-in (administrators can use `/login`); POSTs to those paths answer JSON
`login_required`. A signed-in person manages:
- **Profile:** a display name, sent as `name` with the `profile` scope.
- **Email:** changing it needs proof at both ends. That is an email-link sign-in within ten minutes for the current
  address, then a single-use, browser-bound confirmation (a POST, not the link itself) from the new address. The old
  address is told at request and at change. With a second factor on the account, both steps also need it within
  ten minutes. An address another account in the realm holds gets no email, and the answer is the same. A person
  can start five changes an hour.
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
An admin can reset, block, delete or merge only someone of equal or lower role.
It removes the person's factors, recovery codes and remembered browsers, and ends their sessions. The reason is
audited and the person is told by email.

**Two-factor authentication.** Each client sets `mfa`: `off`; `optional` (required once the person has added a
factor); or `required` (a person without a factor must enrol before the code is issued). A gate in front of every
code and every agent consent sends the browser to `/mfa?request_id=…` (enter a code) or `/account/mfa?request_id=…`
(enrol), and then continues the authorization. Factors: TOTP authenticator apps (RFC 6238: SHA-1, six digits,
30-second steps, one step of drift; each step is accepted once; secrets are sealed with `SEALING_KEY`), and ten
single-use recovery codes (shown once, stored as SHA-256). Ten wrong codes within 15 minutes lock the factor, and
attempts are counted before they are checked, so a parallel burst cannot pass the limit. A client may let a
**trusted browser** skip that client's second factor (trust is per app) for `mfa_trusted_device_days` (1–90, default 0 = never). Trusted browsers
are forgotten when a password or factor changes. **Step-up:** `acr_values=urn:imprim:acr:mfa` demands a second
factor in this session, and a trusted browser does not count. `acr_values` lists acceptable levels in order of
preference, so a request that also lists `urn:imprim:acr:sf` accepts a single factor and demands nothing more. `max_age` (seconds) treats an older primary sign-in as
none, and also bounds the age of the second factor. `prompt=login` and `max_age` are enforced again when the code is
issued, however the sign-in continued. The ID token carries `acr` (`urn:imprim:acr:mfa` after a second
factor, otherwise `urn:imprim:acr:sf`) and `amr` gains `otp` and `mfa`. Under `prompt=none`, a needed second factor
returns `error=interaction_required`. **Agents:** `agent_consent_mfa: required` needs a second factor within 15
minutes before approval. **Administrators** always need a second factor, verified within the hour; the console sends
them to enrol or verify. Adding a factor needs a sign-in within ten minutes and, when the person already has a factor, a second factor
within ten minutes: a sign-in that skipped the second factor can never enrol its own. Removing one, or replacing the recovery
codes, needs a second factor within ten minutes. Each change is audited and emailed to the account.

**Passwords** (client method `password`). A first password is set only within ten minutes of an email link (fresh mailbox proof). New
people choose "Email me a link to set one": an email link with `purpose: "password"` proves the mailbox and opens
`/account/password`, and saving continues the original authorization as a password sign-in (`amr: ["pwd"]`).
`POST /v1/auth/password {request_id, email, password, turnstile}` needs Origin, the browser binding and a pending
request for a client that offers `password`; administrators never use it. An unknown email, an account without a
password and a wrong password all return `401 invalid_grant` "Email or password is incorrect.", after the same key
derivation. Ten failures for one address lock that address (known or not) for 15 minutes from the tenth, and further refused
attempts do not extend it (`429`); attempts
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
An admin in the realm's D1 roster can sign in by email at `/login` before any app is registered. Standalone login is
restricted to that roster; entries are compared case-insensitively. GitHub and Google cannot authenticate administrator
emails, either the provider email or an existing linked account email.

GitHub's stable numeric id is the identity key, not login/email. First linking uses only a verified primary email;
a linked numeric id retains its original user after a provider email change to an unclaimed address. A verified
email belonging to a different live/blocked user, or a tombstone merged elsewhere, is refused; a tombstone
merged into the linked user (or deleted without a merge target) is not a conflict; a provider identity is never reassigned. Provider access tokens are neither
stored nor logged. OAuth state lasts ten minutes, is hashed, browser nonce bound, and consumed before network I/O.

Each client's `sign_in_methods` is an ordered, nonempty list of distinct methods: `email`, `password`, `passkey`,
`github`, `google`, or a provider id from the realm's config. Only those controls appear on its pending sign-in
page; one method is offered directly. Method checks run at magic
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

RP logout uses `client_id` and/or a verified `id_token_hint`, optional exact `post_logout_redirect_uri`, optional `state`, and optional `ui_locales` for the confirmation page. With a session, GET
renders a confirmation form carrying CSRF; POST checks Origin + double submit and deletes the identity session.
The registered URI is checked again at POST. Without a session GET may redirect to the registered URI. An `id_token_hint` must have an ES256 signature from this issuer's local ring, matching issuer/client claims and
(current browser, if present) subject/sid. An expired hint is accepted only for its still-active browser session. No third-party logout URL is accepted without a registered client. The console and the account pages link to `/logout` with no client; a request that names no client and still carries a return URI or state is refused.
Human logout captures durable app-session associations and sends signed OIDC back-channel logout through the queue.
An association expires 30 days after it was created, matching the identity-session lifetime. Token exchange records
the association once per client, subject and identity-session sid; later exchanges do not extend its expiry. Scheduled
maintenance deletes at most 500 expired associations per run. Block, delete, logout and merge capture only unexpired
associations, even if maintenance has not removed expired rows yet. Apps must end any session minted from an Imprim
sign-in within 30 days of that sign-in. An app that needs a longer session must obtain a new sign-in, which creates
a new association.
The form field is `logout_token`, with ES256 header `typ=logout+jwt` and claims `iss`, scalar app `aud`, `sub`, `sid`
when scoped to one session, integer `iat`, `exp=iat+120`, stable event `jti`, and exactly
`events:{"http://schemas.openid.net/event/backchannel-logout":{}}`; never `nonce`. One event is sent per affected client.
Account-wide actions covering multiple sessions of one client omit `sid` to end all sessions for that subject.
Admin session revocation uses the same session-scoped path; merge logs out the disappearing subject and also the
survivor, so both must sign in again.
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
The `error` code never changes with language. `error_description` is translated for people: on HTML error pages and
from the browser endpoints (`/v1/auth/*`, `/account/*`, `/mfa`, `/agent/consent`, `/device`, `/logout`, `/login`).
Every other endpoint, including `/token`, `/register`, `/introspect`, `/revoke`, `/userinfo`, the app APIs and
`/authorize` error redirects, keeps English ASCII (RFC 6749 section 5.2).

## Agent authorization

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
| `GET /account/agents` | Current person's grants, including creation/last-use times and revoked/expired status. |
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
issuer, so each realm names its own events. Client 0.3.0 accepts only
this form; 0.2.0 accepted `typ=JWT`. The receiver verifies signature/issuer/audience/event/
time and deduplicates `jti`; 2xx acknowledges receipt. Delivery uses a ten-second deadline and refuses redirects;
failures retry until the 24-hour creation bound and may reach the configured DLQ. Delivery is at least once within that bound. This event is not an OIDC logout
token and does not end all of the person's app sessions. Human back-channel logout uses a separate durable outbox and the same queue; see CONTROL_PLANE.md.

### Machines, introspection, revocation and the app grant API

**Service clients** (`client_credentials`). A realm admin registers a service client (`POST /admin/api/services`) for
one app. It has a named owner, 1–5 public keys (P-256 or RSA-2048+), scopes from that app's catalogue, and resource
prefixes under the app's own. It authenticates only with `private_key_jwt`: a single-use assertion signed by one of
its keys, and never a shared secret. `POST /token grant_type=client_credentials&client_id=&resource=&scope=` returns a
60-second `at+jwt` with `sub` and `grant_id` both `service:<id>`. Apps recognise machine callers by that prefix and
authorise them as they choose. Disabling or deleting a service client ends its access within a minute.

**Introspection** (RFC 7662, `POST /introspect`, `client_secret_basic`). An app learns whether an access token for
one of *its own* resources is live: signed by the realm, unexpired, its grant unrevoked and its person active, or
its service client active. Any other token gets `{"active":false}`, with no reason.

**Revocation** (RFC 7009, `POST /revoke`) always answers 200. An agent revokes its own grant with its refresh or
access token and its `client_id`. A key-bound agent also signs an assertion, and a DPoP-bound grant needs a proof
from its key. An exchanged token, or one for another audience, revokes nothing. An app (`client_secret_basic`) revokes
grants on its own resources. Anything else is ignored without saying why. Revoking an access token revokes its
whole grant.

**App grant API.** `GET /v1/grants?resource=<workspace resource>` lists the live agent grants on that resource:
person `sub`, agent, scope, created, last used. `POST /v1/grants/revoke {grant_id}` revokes one, for example when a
member leaves the workspace; the agent's refresh is refused at once and the revocation event follows. Both use the
app's client credentials and work only on the app's own resources. Who in the workspace may call them is the app's
decision.

**DPoP** (RFC 9449, header `DPoP` on `/token`).
- **Proofs:** an ES256, RS256 or EdDSA proof, public key only, for this method and URL, issued within the last five
  minutes, with a single-use `jti`.
- **Binding:** the access token then carries `cnf.jkt` and `token_type` is `DPoP`. An agent grant's first proof binds
  the grant to that key; every later exchange or refresh needs a proof from the same key, so a stolen refresh token
  is useless. An app sets `agent_dpop: required` to refuse unbound agent tokens. Service clients may send proofs too.
- **Resource servers:** `imprim-client` 0.5.0 verifies the request's proof against the token:
  `verifyAccessToken(token, { audience, dpop: { proof, method, url } })` checks the key, method, URL, freshness and
  `ath`. Deduplicate the returned `dpop_jti`.

**Token exchange** (RFC 8693, `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`).
- **Request:** app A authenticates with its client secret and presents an agent's access token that was issued for
  A's own resource (`subject_token`, type `access_token`), with `resource` naming app B's resource.
- **Opt-in:** B lists A in `token_exchange_from` with the most scopes A may obtain.
- **Result:** a 60-second token for B with the same person (`sub`), agent (`client_id`) and `grant_id`, so
  revoking the grant ends the chain. `act` records each app (`{"sub":"app:A","client_id":"A"}`, nested for longer
  chains, at most four).
- **Scopes:** B's allowance for A is independent of the scopes the person consented to on A. B decides what it trusts
  A to do on the person's behalf there.
- **Limits:** DPoP-bound tokens, service tokens, and exchanges into an app that requires DPoP are refused. B still
  checks the person's membership.

**User lifecycle events** (`event_token` on the back-channel URI; an app opts in with `user_events: on`). Every
opted-in app that admitted a person receives one signed security event token (RFC 8417, `typ=secevent+jwt`, `aud` = the app, `sub` = the person, a stable `jti`,
five-minute lifetime, `toe` = when the change happened) per change. Apply events last-writer-wins by `toe`. Event types live under `<issuer>/events/`:

| Event | Payload | When |
|---|---|---|
| `user-updated` | `{fields: ["name"]}` or `{fields: ["email"]}` (what changed, never the value) | The person changed their name or email |
| `user-blocked` / `user-unblocked` | `{}` | An admin blocked or unblocked them |
| `user-deleted` | `{}` | They deleted their account, or an admin did |
| `user-merged` | `{into}` | An admin merged them into another account |
| `mfa-reset` | `{}` | An admin reset their second factor |

Delivery uses the same durable outbox, queue, retry, 24-hour window and dead-letter queue as logout. Verify the event
with `imprim-client` 0.6.0 (`handleUserEvent(request)` or `verifyBackchannel(form)` → `kind: 'user'`) and
deduplicate `jti`.

**Audit export.** `GET /admin/api/audit/export?after=<id>` returns the realm's audit rows as NDJSON, oldest first,
1,000 a page, with `x-next-after` while more remain. Audit is kept for 400 days.

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

## Control plane

See [Control plane](CONTROL_PLANE.md) for all `/admin` and `/admin/api/*` routes, scoped email-link sessions,
CSRF and Origin enforcement, reauthentication, transactional audit, block, merge and delete behaviour, and key
rotation.
