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

The Lit console uses the Fire app shell, with a sidebar grouped into apps, realm and platform pages, a top bar and a
phone menu. It covers Clients and the client editor, Services, Users and merge review, Workspaces, Branding, Audit,
Settings, Signing keys and Realms. The Worker checks the admin session before serving the shell and requires the
platform role for Signing keys and Realms. It serves the JSON API under `/admin/api/` and renders the branding
previews and responses to legacy form submissions.

Responses are `no-store`. The Lit shell limits scripts, styles, fonts, connections and form submissions to the
same origin. Images may also use data URLs. The CSP forbids framing, plug-ins and base URLs. Legacy form response
pages load `/imprim/shell.js` for the Fire sidebar, phone menu and hero texture. Writes require the issuer's exact
Origin and a CSRF value that matches the cookie and the session hash.

The API uses **the same scoped session**, including Origin and CSRF on every POST. It does not issue or accept a
separate bearer credential, so the roster and the short admin scope stay authoritative and there is no long-lived
admin secret. Scripts may use the cookie jar and CSRF value from a real admin sign-in; never put these in source
control or logs. There is no CORS permission.

Realm admins manage their realm's clients, service clients, users, workspaces and branding, and can read Audit
and Settings. Platform admins can also manage realms, rosters and signing keys ([Realms](REALMS.md#admins)).

| Method and `/admin/api/` path | Body / response |
| --- | --- |
| GET `clients` | `{clients:[...]}`; secret hashes excluded |
| GET `clients/:id` | Public client configuration, plus `confidential`, integer `version`, `delivery` status and realm provider labels |
| GET `clients/editor/defaults` | Default fields for client registration and realm provider labels |
| POST `clients` | Create (configuration below); returns `{client,client_secret}` once |
| POST `clients/:id` | Partial update with the current `version`; the id cannot change; a stale version returns 409 |
| POST `clients/:id/rotate-secret` | Optional `version` for conflict detection. Public clients need `make_confidential: true`. Returns `{id,client_secret}` once |
| GET `users?q=email-or-id&before=id` | `{users,next}`; 50 rows a page |
| GET `users/:id` | Identities, up to 100 most recent sessions and grants, status and unchanged subject |
| POST `users/:id/block`, `unblock`, `delete` | `{}` |
| POST `users/:id/revoke-session` | `{sid:"..."}`; only this user's session, with durable logout and audit; grants unchanged |
| GET `users/:id/merge?surviving_id=id` | Source and surviving user IDs and emails for review |
| POST `users/:id/merge` | `{surviving_id:"...",confirm_source_email:"source@example.com"}` |
| POST `users/:id/reset-mfa` | `{reason:"..."}`; needs a fresh admin second factor ([Protocol](PROTOCOL.md#sign-in-and-sessions)) |
| GET `audit?actor=id&target=id&before=row-id` | `{audit,next}`; newest first, 50 a page |
| GET `audit/export?after=row-id` | NDJSON, oldest first, 1,000 a page; `x-next-after` while more remain |
| GET `services` | `{services:[...]}`; workspace clients include `workspace_id`, `workspace_name`, `accountable_sub`, `accountable_email` and `expires_at`. |
| POST `services`, `services/:id` | `{id, app_id, name, owner_email, jwks, scopes, resource_prefixes, status}` ([Protocol](PROTOCOL.md#machines-introspection-revocation-and-the-app-grant-api)) |
| POST `services/:id` for a workspace client | `{status:"disabled"}`; the approver manages renewal. |
| POST `services/:id/delete` | `{}`; realm-admin service clients only. |
| GET `workspaces?status=active&before=id` | `{enabled,workspaces,next}`, 50 rows per page, or `{enabled:false}` when shared workspaces are off |
| GET `workspaces/:id` | `{enabled,workspace}` with members, invitations, registered resources, holds and recent audit |
| GET `workspaces/:id/close` | Closure review. A hold or closed workspace returns 409 |
| POST `workspaces` | `{name,products,first_owner_email}`, with an array of product IDs |
| POST `workspaces/:id/rename`, `products` | `{name}` or `{add,remove}` with arrays of product IDs |
| POST `workspaces/:id/invite`, `revoke-invitation` | `{email,role}` or `{invitation_id}` |
| POST `workspaces/:id/role`, `remove-member` | `{sub,role}` or `{sub}` |
| POST `workspaces/:id/close` | `{confirm}` with the current workspace name, case-sensitive |
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

Workspace writes return `{workspace_id}`. If invitation delivery fails after the write, the API returns 503
`workspace_invitation_email_failed` with the saved workspace ID.

`GET /admin/branding/preview?client=<id>` renders an app's sign-in page with its saved branding. The same preview
is available at `GET /admin/api/branding/preview?client=<id>`.
`GET /admin/branding/email-preview` renders a sandboxed sample of the realm's saved sign-in email.

JSON POSTs use `Content-Type: application/json`, `Origin: <issuer>`, the session and CSRF cookies and
`X-CSRF-Token`. Legacy form POST URLs without `/api` accept a `csrf` form field.

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
[Configuration](CONFIGURATION.md#app-client-settings-clients). The [Lit client editor](../apps/web/src/screens/admin/client/editor.ts)
uses Fire controls for URL lists, scope pairs, choices and switches. Branding overrides use a JSON code field. The
editor submits JSON to the admin API and shows the outcome in a toast. Existing form POST URLs still accept
their original fields. When the Worker rejects a legacy form submitted by an authenticated admin asking for HTML,
it renders an error page. API clients receive a JSON error. A back-channel HTTPS URI is required. Signup defaults
to invited and agents default off. Settings are read-only. Turnstile and binding limits are deployment changes,
and D1 budgets are code constants.

Client edits need the integer `version` returned by GET. A missing or malformed edit version returns 400.
The Lit editor also sends this version when rotating a secret. The transaction-time check returns 409 if the
version changed, with no write or audit entry. Every edit or secret rotation increments the version.
Rotating a public client's secret needs explicit `make_confidential:true` (or the console checkbox), because it
changes token endpoint authentication; `admin_client_secret_rotate.detail.made_confidential` records it. The new
secret is returned once, and the old one stops working at once.

Merge first opens a read-only review page naming both source and survivor emails and IDs. Its final form needs the
source email retyped. The API checks `confirm_source_email` and asserts that the source email is unchanged inside the transaction. The source is
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
