# Architecture

Imprim is a Cloudflare Worker with D1 state, an email binding, rate-limit bindings, a Queue and an every-minute trigger. `CONFIG_CACHE` KV is declared but not read. The client package runs in app Workers or Node. Apps keep authorization, workspace membership, API tokens and their own sessions. See [Protocol](PROTOCOL.md) for exact endpoint contracts and [Operations](OPERATIONS.md) for deployment order.

## Components

| Component | Work |
|---|---|
| Worker routes | OIDC and agent OAuth endpoints, sign-in pages, account page, admin console, machine endpoints. |
| Realms | The request host selects a realm; every query is scoped to it ([Realms](REALMS.md)). |
| D1 | Users, client policy, short-lived requests, sessions, keys, grants, audit. |
| Email binding | Sends a magic link after neutral request acceptance. |
| Upstream providers | GitHub, Google, Microsoft, Apple and any OIDC issuer; their tokens are not stored. |
| Have I Been Pwned | Range API (k-anonymity) for breached-password checks; only a 5-character hash prefix leaves. |
| Turnstile | Checks email requests when both keys are configured. |
| `AUTH_LIMITER`, `API_LIMITER` | Per-IP Workers rate bindings. |
| `LOGOUT_QUEUE` | Delivers back-channel logout, agent revocation and user lifecycle events; failures retry and reach the DLQ. |
| Every-minute trigger | Rotates keys, deletes expired state and flushes pending revocations. |

## D1 schema

Migrations `0001` through `0018` create or extend these tables. Every realm-owned row carries `realm_id`. Timestamps are stored in milliseconds unless a protocol claim says otherwise.

| Table | Contents |
|---|---|
| `users` | Stable subject, normalized email, verification and active/blocked/deleted status. |
| `user_identities` | GitHub numeric ID or Google `sub` linked to a user. |
| `clients` | App credentials, URLs, admission, sign-in and agent policy. |
| `auth_requests` | Browser-bound pending app or agent authorization request. |
| `magic_links` | Hashed, browser-bound email link and request reference. |
| `oauth_states` | Hashed upstream state, PKCE verifier, provider and Google nonce. |
| `sessions` | Hashed identity session and CSRF, `sid`, method and Google `hd`. |
| `codes` | Single-use human OIDC code, redirect, challenge and session. |
| `access_tokens` | Hashed opaque UserInfo bearer token. |
| `consumed_codes` | One-day human code replay tombstones. |
| `signing_keys` | Public ES256 JWK and sealed private JWK by generation. |
| `invitations` | Client-scoped email admission with expiry. |
| `audit` | Append-only event, actor, detail and creation time. |
| `rate_limits` | Separate D1 budgets and Turnstile replay records. |
| `agent_clients` | Public dynamic registrations and last use. |
| `agent_metadata_cache` | Fresh HTTPS client ID documents, bounded by time and count. |
| `agent_grants` | Person, agent, app, resource, scopes, consent and expiry. |
| `agent_codes` | Hashed, single-use agent authorization code. |
| `agent_refresh_tokens` | Hashed current/spent refresh values and replacement links. |
| `agent_devices` | Hashed device/user codes, poll state and grant reference. |
| `agent_revocation_outbox` | Durable app revocation notification pending queue send. |
| `realms`, `admins` | Realm host, issuer, config (secrets only as `{"env":…}` references) and the admin roster. |
| `client_admissions` | Which people each app has admitted, and by what proof. |
| `app_sessions`, `logout_outbox` | Sessions per app, and durable back-channel logout delivery. |
| `user_passwords` | PBKDF2 password hash, failure count and lockout. |
| `mfa_factors`, `recovery_codes`, `trusted_devices` | TOTP secrets (sealed), hashed recovery codes, per-app remembered browsers. |
| `webauthn_credentials`, `webauthn_challenges` | Passkey public keys and sign counters; single-use ceremony challenges. |
| `seen_devices`, `email_changes` | New-device notices and pending, link-confirmed email changes. |
| `service_clients` | Machine identities: public JWKS, scopes and resource prefixes under one app. |
| `dpop_proofs` | DPoP proof `jti` replay records. |
| `user_event_outbox` | Signed user lifecycle events pending delivery to apps that opted in. |
| `brand_assets` | Realm-scoped, content-addressed logos and marks. |

`audit` rejects updates and deletes through triggers. App client IDs and agent client IDs use separate tables. Imported Assay principal IDs become `users.id` and remain token `sub`.

## Request flows

**App authorization code.** The app starts a browser-bound login transaction with `state`, `nonce` and PKCE S256. `/authorize` checks client and exact redirect, then binds the pending request to the identity browser cookie. An existing allowed identity session can continue; otherwise the person uses an enabled method. Identity issues a 60-second code and returns `code`, `state` and `iss`. `/token` authenticates the app, checks the exact redirect and verifier, atomically consumes the code, and returns an ES256 ID token plus an opaque UserInfo token. The app validates the ID token and applies local admission before issuing its own session. Human app flows have no refresh token.

**Magic link.** A same-origin POST checks the browser, optional Turnstile and rate limits, then returns neutral `{accepted:true}`. Eligible addresses receive a 15-minute link at `/login#token=…`. The person clicks Sign in in the original browser. Verification atomically consumes the hash, rechecks admission and method policy, and issues an identity session. A GET or link prefetch cannot consume the token.

**GitHub and Google.** Both start from a pending authorization and store hashed, browser-bound OAuth state. Their callbacks consume state before network I/O, exchange the provider code and recheck current client policy. GitHub links by stable numeric ID and verified primary email. Google verifies its signed ID token, audience, nonce and verified email, then links by Google `sub`. A restricted app also checks the signed `hd` claim. Neither provider's access token is stored.

**SSO.** A top-level `/authorize` redirect reuses a valid identity session if its method and Google domain satisfy the current app policy. `prompt=none` returns `login_required` when it cannot proceed without sign-in. Agent requests still require consent and return `consent_required` for `prompt=none`.

**Logout.** `GET /logout` validates the app and optional registered return URI, then shows a confirmation if a session exists. The same-origin CSRF-protected POST deletes the identity session, associated codes and UserInfo tokens. App sessions remain the app's responsibility; each app with a session is sent a signed back-channel `logout_token` through the queue. Agent grant revocation sends a distinct signed `revocation_token`.

**Invitations.** A confidential app calls `POST /v1/invitations` with Basic authentication. Identity stores a normalized, client-scoped email for 30 days. Sign-in admission can use it, but app workspace membership stays local.

**Agent flow.** A resource challenge leads to issuer discovery. The public agent uses an HTTPS metadata document or dynamic registration, then PKCE authorization or device code. The person signs in through the owning app and approves the resource and scopes. Identity issues a short ES256 access JWT and rotating refresh token. See [Agent access](AGENT_ACCESS.md).

**Passwords and second factors.** A password sign-in counts the attempt atomically before checking the hash, so
parallel guesses cannot pass the lockout. A first password, and every reset, needs a fresh email link. When the app
or the person requires a second factor, sign-in continues to a TOTP, passkey or recovery-code challenge before the
session is issued; `acr_values` and `max_age` force a fresh or stronger sign-in. See [Protocol](PROTOCOL.md).

**Machines.** A service client proves its key with `private_key_jwt` and gets a 60-second token for resources under
its app as `service:<id>`. Agents may bind tokens to a DPoP key, and an app may exchange a token it received for one
aimed at another app that trusts it (RFC 8693).

**Branding.** Pages are rendered with markers that `withBrand` fills from the realm's and the app's branding:
header, theme stylesheet link, favicon and footer. Everything inserted is escaped or an asset id ([Branding](BRANDING.md)).

## Keys and maintenance

Private ES256 JWKs are AES-256-GCM sealed with `SEALING_KEY` and `kid` as authenticated data. A successor is published one hour before its 90-day activation; old keys are retained for 24 hours after retirement. An unreadable key is retired and audited; treat that event as an incident. The client caches JWKS for up to 24 hours and refreshes on an unknown `kid`. Replacing `SEALING_KEY` requires a separate migration plan. The every-minute trigger also removes expired short-lived rows, retains expired device rows for one day, deletes unused dynamic registrations after 30 days, and flushes revocation outbox rows.

## Limits, challenge and records

`AUTH_LIMITER` is 20 per 60 seconds and `API_LIMITER` is 120 per 60 seconds in Wrangler. Magic requests add five email/IP attempts per hour; Turnstile degraded mode uses two and five per-IP per hour. Agent registration has ten/IP/hour; device issuance and user-code lookup each have 20/IP/hour. Missing rate bindings fail explicitly. See [Security](SECURITY.md) for metadata fetch and redirect limits.

When both Turnstile keys are absent, the challenge is off for local/development use. Partial configuration fails. A siteverify outage enters audited, existing-active-user-only email mode under stricter limits. An invalid challenge or rejected secret still fails. No alternate provider is selected.

Structured error logs record request path and an error type, not credentials. The Worker audits sign-in, replay, degraded Turnstile, failed mail, unreadable keys and agent grant/token/refresh/revoke activity. The audit table is append-only. Cloudflare invocation logs are disabled in Wrangler to avoid recording OAuth callback query credentials. Live logging and retention still need deployment review.
