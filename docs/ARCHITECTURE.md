# Architecture

Imprim is a Cloudflare Worker with D1 state, an email binding, rate-limit bindings, a Queue, an every-minute trigger and static assets for the Fire design system. The client package runs in app Workers or Node. Apps keep authorization, workspace membership, API tokens and their own sessions. See [Protocol](PROTOCOL.md) for exact endpoint contracts, [Deploying](DEPLOY.md) for setup and [Operations](OPERATIONS.md) for running it.

## Components

| Component | Work |
|---|---|
| Worker routes | OIDC and agent OAuth endpoints, sign-in pages, account page, admin console, machine endpoints. |
| Pages | Server-rendered HTML built from [Fire](fire/README.md) components (`pages/ui.mjs`, `pages/layout.mjs`, `pages/shell.mjs`). Every text is escaped; sign-in and consent screens load no Fire JavaScript. |
| Languages | `i18n/`: the request's language, chosen once per request from `ui_locales`, the person's saved language, `Accept-Language` and the brand, and the catalogues that translate English message ids ([Languages](TRANSLATING.md)). The admin console is English. |
| Email | `services/email/`: every message as data, rendered as plain text and a branded HTML part in the recipient's language, with an inline logo; sent through the email binding. |
| Static assets | Fire's CSS, modules, fonts and icons at `/fire/*`, and the branding editor at `/imprim/*`, from `apps/server/public/`. Served by Workers Static Assets before the Worker runs, with headers from `public/_headers`. |
| Realms | The request host selects a realm; every query is scoped to it ([Realms](REALMS.md)). |
| D1 | Users, client policy, short-lived requests, sessions, keys, grants, audit. |
| Email binding | Sends sign-in links after neutral request acceptance, and security notices, each as text and HTML. |
| Upstream providers | GitHub, Google, Microsoft, Apple and any OIDC issuer; their tokens are not stored. |
| Have I Been Pwned | Range API (k-anonymity) for breached-password checks; only a 5-character hash prefix leaves. |
| Turnstile | Checks email requests when both keys are configured. |
| `AUTH_LIMITER`, `API_LIMITER` | Per-IP Workers rate bindings. |
| `LOGOUT_QUEUE` | Delivers back-channel logout, agent revocation and user lifecycle events; failures retry and reach the DLQ. |
| Every-minute trigger | Rotates keys per realm, deletes expired state and re-queues pending back-channel events. |

## D1 schema

Migrations `0001` through `0021` create or extend these tables. Every realm-owned row carries `realm_id`. Timestamps are stored in milliseconds unless a protocol claim says otherwise.

| Table | Contents |
|---|---|
| `users` | Stable subject, normalized email, verification, active/blocked/deleted status and saved language. |
| `user_identities` | A provider id and that provider's subject (GitHub numeric id, Google `sub`, or a registry provider's `sub`) linked to a user. |
| `clients` | App credentials, URLs, admission, sign-in and agent policy. |
| `auth_requests` | Browser-bound pending app or agent authorization request, with its sanitized `ui_locales`. |
| `magic_links` | Hashed, browser-bound email link and request reference. |
| `oauth_states` | Hashed upstream state, PKCE verifier, provider and nonce. |
| `sessions` | Hashed identity session and CSRF, `sid`, method, `amr`, second-factor time, admin scope, device, place and Google `hd`. |
| `codes` | Single-use human OIDC code, redirect, challenge and session. |
| `access_tokens` | Hashed opaque UserInfo bearer token. |
| `consumed_codes`, `agent_consumed_codes` | Human and agent code replay tombstones. |
| `signing_keys` | Public JWK and sealed private JWK by realm, algorithm (ES256 or RS256) and generation. |
| `invitations` | Client-scoped email admission with expiry. |
| `audit` | Append-only event, actor, detail and creation time. |
| `rate_limits` | Separate D1 budgets and Turnstile replay records. |
| `agent_clients` | Public dynamic registrations and last use. |
| `agent_metadata_cache` | Fresh HTTPS client ID documents, bounded by time and count. |
| `agent_grants` | Person, agent, app, resource, scopes, consent and expiry. |
| `agent_codes` | Hashed, single-use agent authorization code. |
| `agent_assertions` | Single-use `private_key_jwt` assertion `jti` records. |
| `agent_refresh_tokens` | Hashed current/spent refresh values and replacement links. |
| `agent_devices` | Hashed device/user codes, poll state and grant reference. |
| `agent_revocation_outbox` | Durable app revocation notification pending queue send. |
| `realms`, `admins` | Realm host, issuer, config (secrets only as `{"env":…}` references, plus branding) and the admin roster. |
| `client_admissions` | Which people each app has admitted, and by what proof. |
| `app_sessions`, `logout_outbox` | Sessions per app, and durable back-channel logout delivery. |
| `admin_assertions` | Always empty. Its CHECK constraint aborts an admin write batch whose session, role or version guard fails. |
| `user_passwords` | PBKDF2 password hash, failure count and lockout. |
| `mfa_factors`, `recovery_codes`, `trusted_devices` | TOTP secrets (sealed), hashed recovery codes, per-app remembered browsers. |
| `webauthn_credentials`, `webauthn_challenges` | Passkey public keys and sign counters; single-use ceremony challenges. |
| `seen_devices`, `email_changes` | New-device notices and pending, link-confirmed email changes. |
| `service_clients` | Machine identities: public JWKS, scopes and resource prefixes under one app. |
| `dpop_proofs` | DPoP proof `jti` replay records. |
| `user_event_outbox` | Signed user lifecycle events pending delivery to apps that opted in. |
| `brand_assets` | Realm-scoped, content-addressed logos and marks. |

`audit` rejects updates, and deletes of rows younger than 400 days, through triggers. App client IDs and agent client IDs use separate tables. Users imported with `scripts/import-users.mjs` keep their ids as `users.id`, which is the token `sub`.

## Request flows

**App authorization code.** The app starts a browser-bound login transaction with `state`, `nonce` and PKCE S256. `/authorize` checks client and exact redirect, then binds the pending request to the identity browser cookie. An existing allowed identity session can continue; otherwise the person uses an enabled method. Imprim issues a 60-second code and returns `code`, `state` and `iss`. `/token` authenticates the app, checks the exact redirect and verifier, atomically consumes the code, and returns an ES256 ID token plus an opaque UserInfo token. The app validates the ID token and applies local admission before issuing its own session. Human app flows have no refresh token.

**Magic link.** A same-origin POST checks the browser, optional Turnstile and rate limits, then returns neutral `{accepted:true}`. Eligible addresses receive a 15-minute link at `/login#token=…`. The person clicks Sign in in the original browser. Verification atomically consumes the hash, rechecks admission and method policy, and issues an identity session. A GET or link prefetch cannot consume the token.

**Upstream providers.** GitHub, Google and every registry provider (Microsoft, Apple, any OIDC issuer) start from a pending authorization and store hashed, browser-bound OAuth state with PKCE. Their callbacks consume state before network I/O, exchange the provider code and recheck current client policy. GitHub links by stable numeric ID. Google and registry providers verify a signed ID token, audience, nonce and email, then link by the provider's `sub`. A Google-restricted app also checks the signed `hd` claim. No provider access token is stored. An email links an existing account only with mailbox proof ([Protocol](PROTOCOL.md#sign-in-and-sessions)).

**SSO.** A top-level `/authorize` redirect reuses a valid identity session if its method and Google domain satisfy the current app policy. `prompt=none` returns `login_required` when it cannot proceed without sign-in. Agent requests still require consent and return `consent_required` for `prompt=none`.

**Logout.** `GET /logout` validates the app and optional registered return URI, then shows a confirmation if a session exists. The same-origin CSRF-protected POST deletes the identity session, associated codes and UserInfo tokens. App sessions remain the app's responsibility; each app with a session is sent a signed back-channel `logout_token` through the queue. Agent grant revocation sends a distinct signed `revocation_token`.

**Invitations.** A confidential app calls `POST /v1/invitations` with Basic authentication. Imprim stores a normalized, client-scoped email for 30 days. Sign-in admission can use it, but app workspace membership stays local.

**Agent flow.** A resource challenge leads to issuer discovery. The public agent uses an HTTPS metadata document or dynamic registration, then PKCE authorization or device code. The person signs in through the owning app and approves the resource and scopes. Imprim issues a short ES256 access JWT and rotating refresh token. See [Agent access](AGENT_ACCESS.md).

**Passwords and second factors.** A password sign-in counts the attempt atomically before checking the hash, so
parallel guesses cannot pass the lockout. A first password, and every reset, needs a fresh email link. When the app
or the person requires a second factor, sign-in continues to a TOTP, passkey or recovery-code challenge before the
session is issued; `acr_values` and `max_age` force a fresh or stronger sign-in. See [Protocol](PROTOCOL.md).

**Machines.** A service client proves its key with `private_key_jwt` and gets a 60-second token for resources under
its app as `service:<id>`. Agents may bind tokens to a DPoP key, and an app may exchange a token it received for one
aimed at another app that trusts it (RFC 8693).

**Pages and branding.** Pages are server-rendered Fire markup in two layouts. Sign-in, consent and result screens
are a centred card under the brand (`pages/layout.mjs`). The admin console and the account pages sit in Fire's app
shell: a sidebar, a top bar, a page hero and a phone menu (`pages/shell.mjs`). Both carry fixed markers that
`withBrand` fills from the realm's and the app's branding: the name, the look's `<html>` attributes, the
`/assets/theme.css` link, the favicon, the logo or mark (the brand's initial in a dot matrix until one is uploaded),
the footer, who is signed in, and `<html lang>` for the request's language. Navigation that only administrators use is dropped for everyone else. Every page
ends with "Powered by Imprim". Everything inserted is escaped or an asset id. Fire's own files come from static assets, and every class on a page is Fire's
([Branding](BRANDING.md), [Fire](fire/README.md)).

## Keys and maintenance

Private ES256 and RS256 JWKs are AES-256-GCM sealed with `SEALING_KEY` and `kid` as authenticated data. A successor is published one hour before its 90-day activation; old keys are retained for 24 hours after retirement. An unreadable key is retired and audited; treat that event as an incident. The client refetches JWKS after 10 minutes, refreshes once on an unknown `kid`, and falls back to keys up to 24 hours old only while the issuer is unreachable. Replacing `SEALING_KEY` requires an offline reseal of every sealed value. The every-minute trigger also removes expired short-lived rows, retains expired device rows for one day, deletes unused dynamic registrations after 30 days, and re-queues pending outbox rows ([Operations](OPERATIONS.md#retention-and-the-scheduled-handler)).

## Limits, challenge and records

`AUTH_LIMITER` is 20 per 60 seconds and `API_LIMITER` is 120 per 60 seconds in Wrangler. Email-link requests add five per recipient and five per recipient and address an hour; Turnstile degraded mode lowers these to three and two, plus five per address an hour. Agent registration has ten per address an hour, anonymous agent `/authorize` 60, and device issuance and user-code lookup 20 each. Missing rate bindings fail explicitly. See [Security](SECURITY.md) for metadata fetch and redirect limits.

When both Turnstile keys are absent, the challenge is off for local/development use. Partial configuration fails. A siteverify outage enters audited, existing-active-user-only email mode under stricter limits. An invalid challenge or rejected secret still fails. No alternate provider is selected.

Structured error logs record request path and an error type, not credentials. The Worker audits sign-in, replay, degraded Turnstile, failed mail, unreadable keys, admin actions and agent grant, token, refresh-reuse and revoke activity (a normal refresh writes no audit row). The audit table is append-only. Cloudflare invocation logs are disabled in Wrangler to avoid recording OAuth callback query credentials. Review live logging and retention on your own deployment.
