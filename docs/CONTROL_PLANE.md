# Control plane

The admin console at `/admin`, its JSON API under `/admin/api/`, back-channel delivery and key rotation. Live
delivery latency, email and browser flows, and integration with a real app are release gates
([Operations](OPERATIONS.md#release-gates)).

## Authentication and routes

Open `/admin`, then sign in at `/login` with a browser-bound email link for an address in the realm's D1 admin
roster (`admins` table; see [Realms](REALMS.md#admins)). Standalone email verification sets `sessions.admin_until`
one hour ahead and appends `admin_sign_in` in the same batch. The normal 30-day identity session alone does not
grant admin access, and an app's sign-in for an administrator carries no admin scope.

Every admin request checks the active user, verified email, the email method, the roster and the admin scope's
expiry. Administrators also need a second factor, verified within the hour: the console sends one without a factor
to `/account/mfa` (`mfa_enrolment_required`) and one without a recent check to `/mfa` (`mfa_required`), then back.
Every write needs a sign-in within the preceding ten minutes (`reauth_required`), and every write batch rechecks the
session, role and account in the same transaction.

HTML lives under `/admin/{clients,users,audit,services,branding,settings,keys,realms}`. Pages are built with
[Fire](fire/README.md), rendered on the server: no inline scripts, no frontend build, no runtime dependencies.
Every page sits in Fire's app shell: a sidebar grouped into apps, realm and platform pages (the platform group shows
only to platform administrators; the pages themselves refuse everyone else), a top bar, and a menu on phones.
Responses are `no-store`. The console CSP is `default-src 'none'` with `script-src 'self'`, `style-src 'self'`,
`img-src 'self' data:`, `font-src 'self'`, `form-action 'self'`, `frame-ancestors 'none'` and `base-uri 'none'`.
The one script on every page is `/imprim/shell.js`, a static module that loads Fire's shell and texture
modules for the sidebar, the phone menu and the hero texture; it makes no requests. Only the Branding page adds
`connect-src 'self'`, for Fire's Tweaks panel and the branding editor module. Mutations
are POST only, with the exact issuer Origin and a cookie/submitted CSRF value matching the stored hash.

The API uses **the same scoped session**, including Origin and CSRF on every POST. It does not issue or accept a
separate bearer credential, so the roster and the short admin scope stay authoritative and there is no long-lived
admin secret. Scripts may use the cookie jar and CSRF value from a real admin sign-in; never put these in source
control or logs. There is no CORS permission.

Realm admins manage their realm's clients, users, audit, service clients and branding. Platform admins can also
manage realms, rosters and signing keys ([Realms](REALMS.md#admins)).

| Method and `/admin/api/` path | Body / response |
| --- | --- |
| GET `clients` | `{clients:[...]}`; secret hashes excluded |
| GET `clients/:id` | Public client configuration, plus `confidential`, integer `version` and `delivery` status |
| POST `clients` | Create (configuration below); returns `{client,client_secret}` once |
| POST `clients/:id` | Partial update with the current `version`; the id cannot change; a stale version returns 409 |
| POST `clients/:id/rotate-secret` | `{}` for confidential clients; public clients need `{make_confidential:true}`; returns `{id,client_secret}` once |
| GET `users?q=email-or-id&before=id` | `{users,next}`; 50 rows a page |
| GET `users/:id` | Identities, up to 100 most recent sessions and grants, status and unchanged subject |
| POST `users/:id/block`, `unblock`, `delete` | `{}` |
| POST `users/:id/revoke-session` | `{sid:"..."}`; only this user's session, with durable logout and audit; grants unchanged |
| POST `users/:id/merge` | `{surviving_id:"...",confirm_source_email:"source@example.com"}` |
| POST `users/:id/reset-mfa` | `{reason:"..."}`; needs a fresh admin second factor ([Protocol](PROTOCOL.md#sign-in-and-sessions)) |
| GET `audit?actor=id&target=id&before=row-id` | `{audit,next}`; newest first, 50 a page |
| GET `audit/export?after=row-id` | NDJSON, oldest first, 1,000 a page; `x-next-after` while more remain |
| GET `services` | `{services:[...]}` |
| POST `services`, `services/:id` | `{id, app_id, name, owner_email, jwks, scopes, resource_prefixes, status}` ([Protocol](PROTOCOL.md#machines-introspection-revocation-and-the-app-grant-api)) |
| POST `services/:id/delete` | `{}` |
| GET `branding` | `{branding, version}` for the realm |
| POST `branding` | `{branding, version}`; validated; a stale version returns 409 ([Branding](BRANDING.md)) |
| POST `branding/assets` | `{content_type, data}` (base64, at most 256 KiB); returns `{id, url}` |
| GET `settings` | Turnstile state, rate-limit description and pending delivery counts |
| GET `keys` | Platform only. Public key metadata, activation, retirement and status; no sealed or private JWK |
| POST `keys/rotate` | Platform only. `{}`; returns the new `kid` and activation time |
| POST `keys/:kid/revoke` | Platform only. Removes the key from JWKS at once and signs with a replacement ([Operations](OPERATIONS.md#keys-and-rotation)) |
| GET `realms` | Platform only. `{realms:[...]}` |
| POST `realms`, `realms/:id` | Platform only. `{id, issuer, display_name, config, status, version}` |
| POST `realms/:id/admins` | Platform only. `{email, role}`; `role: null` removes; admins cannot change their own role |

`GET /admin/branding/preview?client=<id>` renders an app's sign-in page with the realm's current branding.

JSON POSTs use `Content-Type: application/json`, `Origin: <issuer>`, the session and CSRF cookies and
`X-CSRF-Token`. A `csrf` body field is also accepted. HTML forms post to the same paths without `/api`.

Example client body:

```json
{
  "id": "my-app",
  "redirect_uris": ["https://app.example.com/auth/callback"],
  "post_logout_uris": ["https://app.example.com/signed-out"],
  "backchannel_uri": "https://app.example.com/auth/backchannel",
  "signup_policy": "invited",
  "sign_in_methods": ["email", "passkey", "google"],
  "branding": {"name": "My app"}
}
```

New clients are confidential. The server generates a random secret and stores only its SHA-256 digest; neither the
secret nor the digest appears in later reads or audit. Other settings are listed in
[Configuration](CONFIGURATION.md#app-client-settings-clients). The client editor (`admin/client-editor.mjs`) gives each setting the control that fits it: lists of URLs and
domains as tokens, names with values as rows, choices as segmented buttons or checkboxes, yes or no as a switch, and
a number with its unit. Only the branding override is raw JSON, in a code field. The form posts plain fields, which
`admin/client-form.mjs` turns into the object the API takes: a list arrives one value per line, and an unchecked
switch arrives as nothing. `/imprim/forms.js` loads Fire's forms module for these controls; without it each is still
a usable text area. A form the server refuses comes back as a console page that says why, with the browser's Back
keeping what was entered; the API and scripts still get the JSON error. A
back-channel HTTPS URI is required. Signup defaults to invited and agents default off. Settings are read-only:
Turnstile and binding limits are deployment changes, and D1 budgets are code constants.

Client edits need the integer `version` returned by GET; the HTML editor carries it as a hidden input. A
transaction-time version check stops concurrent edits from overwriting each other. A missing or malformed version
returns 400; a changed one returns 409 with no update audit. Every edit or secret rotation increments the version.
Rotating a public client's secret needs explicit `make_confidential:true` (or the console checkbox), because it
changes token endpoint authentication; `admin_client_secret_rotate.detail.made_confidential` records it. The new
secret is returned once, and the old one stops working at once.

Merge first opens a read-only review page naming both source and survivor emails and IDs. Its final form needs the
source email retyped; the API enforces the same `confirm_source_email` match inside the transaction. The source is
deleted into `surviving_id`, never the reverse. Roster comparisons and pending email-link removal are
case-insensitive. An admin can block, delete, merge or reset only someone of equal or lower role. Malformed path
percent-encoding returns 400.

## Blocking and durable delivery

Block and delete change user status, revoke every grant, remove all identity sessions and outstanding email links,
deny approved device codes, and append the admin audit event in one D1 transaction. Code, token and consent issuance
check current account state again at their own transaction boundary. Unblock only changes `blocked` to `active`; it
never restores grants, sessions, codes or consumed links. Deleted and merged users cannot be unblocked.

At human token exchange, `app_sessions` records `(client_id, user_id, sid)`. The association outlives the identity
session and UserInfo token, but expires 30 days after creation. Block and delete capture **unexpired** associations
in `logout_outbox` before clearing them, one event per client: a single session keeps its `sid`; several sessions
for one client produce a subject-wide token without `sid`. Normal logout and admin session revocation capture only
their `sid`. Merge ends both users' sessions and grants, moves provider identities to the survivor, and marks the
source deleted with `merged_into`. Same-user, self-admin, missing or inactive survivor, and same-provider conflicts
fail; races roll back. App memberships and data are not merged by Imprim. A linked provider identity can sign in to
the survivor even when its provider email remains on the deleted source.

Human, agent and user events dispatch right after the change. The logout queue carries stable event IDs; the
every-minute cron re-queues unsent or unacknowledged events, paging through the whole backlog 100 at a time. The
consumer signs at delivery, POSTs without following redirects, has a 10-second timeout, and retries after
10 seconds. After 5 queue retries the message goes to the dead-letter queue, but the outbox row stays eligible for
the cron. Delivery records `delivered_at`; a duplicate queue message is acknowledged without another POST. A lost
response can still repeat a POST, so receivers must atomically deduplicate the stable `jti`, apply the effect, and
return **2xx on duplicates**.

An event still undelivered 24 hours after creation becomes `expired` and is never signed or sent. The dispatcher
expires old rows before queueing; a late queue message is acknowledged without delivery. Each expiry writes one
`backchannel_expired` audit row with client ID, event kind and event ID, and keeps the last error. Receivers must
keep replay IDs for at least 24 hours plus the token lifetime and permitted clock skew: 120 seconds for human
logout, 300 seconds for agent revocation and user events.

Human requests carry `logout_token` with `iss`, app `aud`, `sub`, `sid` where known, stable `jti`, `iat`, `exp` and
`events:{"http://schemas.openid.net/event/backchannel-logout":{}}`. The JWT uses the app's ID-token algorithm (ES256 unless it chose RS256), `typ=logout+jwt`, valid for
120 seconds, without `nonce`, following [OIDC Back-Channel
Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html). Agent events use `revocation_token` and user
events `event_token` ([Protocol](PROTOCOL.md)). `imprim-client` provides `verifyLogoutToken`,
`verifyRevocationToken`, `handleUserEvent` and `verifyBackchannel(form)`, which accepts all three at one URI. They
verify only; durable deduplication and the effect stay with the app. See the [package
README](https://github.com/Vibernt/imprim/blob/main/packages/imprim-client/README.md).

The action response confirms local revocation and labels delivery as asynchronous. Settings shows pending counts,
the oldest pending event and clients missing a destination. A missing URI or failed dependency never counts as
delivered. Each attempt resolves the client's **current** `backchannel_uri`, so a correction applies to pending
events; the captured outbox `uri` is diagnostic only. With no current URI, `delivery_state` is `missing_uri`, no
request is sent and the event stays pending. Success sets `delivered`. Each client page and
`GET /admin/api/clients/:id` show undelivered and expired counts and events with their last error. No other queue,
provider or direct delivery path is used.

**Agent access bound.** Access JWTs live at most **60 seconds**, also capped by the grant's expiry. The client
requires that maximum lifetime and rejects at `exp` without leeway. Future `iat` and `nbf` allow 60 seconds by
default; `verifyAccessToken(token, {audience, clockSkewSeconds})` accepts an integer skew from 0 to 60. Refresh
stops at once. With synchronised clocks and verification on every request, the most offline access left after a
block is 60 seconds, whatever the queue's state. Apps must not cache a successful authorization beyond token expiry
or add expiry tolerance. A long-running operation or stream needs its own deadline or reauthorization.

Delivery to app sessions cannot be guaranteed within a minute during a queue, network or receiver outage. The
healthy-path target is under one minute; measure it on your deployment. Local tests show state changes, dispatch,
retries and receiver behaviour, not a production latency guarantee.

## Rotation and audit

Rotate now commits a new sealed key in each ring (ES256 and RS256) and an audit event for each. JWKS shows the public key at once and signing starts
**one hour later**; another pending rotation is refused. The previous healthy key stays public for at least
24 hours after replacement, longer than the longest token (ten minutes). `verification_until` tells healthy retired
keys from unreadable-key recovery. Clients cache keys and refresh once on an unknown `kid`; no stale verification is
invented if a fetch fails.

Every successful admin action and its audit row commit together, with actor, target and non-secret detail. Client
edits record the changed field names, including every redirect, logout and back-channel URI change, without URI
query strings. Audit is append-only under its triggers, and filters use dedicated actor and target indexes.

## Schema and retention

Migrations `0005_control_plane.sql`, `0006_security_review.sql` and `0007_backchannel_expiry.sql` add app-session
associations, the logout outbox, delivery acknowledgement and states, admin scope expiry, audit targets and indexes,
key verification retention, client versions, last errors and expiry indexes, and the empty `admin_assertions` table
whose CHECK constraint aborts unsafe batches. [Deploying](DEPLOY.md#upgrading-an-existing-deployment) covers
applying migrations in order.

Scheduled maintenance removes at most 500 delivered rows per outbox per run, once `delivered_at` is more than
30 days old, which leaves a month for incident review. Pending and `missing_uri` rows and the audit log are never
pruned by this cleanup. App-session associations expire 30 days after creation and maintenance removes at most 500
expired ones per run; fan-out ignores expired rows even before cleanup. Apps must end sessions minted from an
Imprim sign-in within 30 days of that sign-in.

Local coverage: real SQLite transactions; Worker request smoke tests; HTML form submission, escaping and security
headers; admin boundaries; every grant path blocked; concurrent mutation checks; merge refusal; audit rollback;
secret non-disclosure; fake signed receivers with persisted replay IDs; queue and receiver outages; more than 100
events; key overlap; and client artifact parity. Native-browser interaction and production bindings are untested.
