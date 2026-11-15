# M4 control plane

Local implementation dated 2026-11-06. Production delivery latency, email/browser flows and app integration
remain deployment gates. No production changes or Assay edits are part of this worktree.

## Authentication and routes

Open `/admin`, then sign in at `/login` using a browser-bound magic link for an address in the realm's D1 admin roster (`admins` table; see [Realms](REALMS.md#admins)).
Standalone email verification adds `sessions.admin_until` for one hour and atomically appends `admin_sign_in`.
The normal 30-day identity session alone does not grant admin access. An app's login for an administrator also
has no admin scope. Every admin request checks active user, verified email, email method, roster and scope expiry.
Block/unblock/delete/merge, session revocation and key/secret rotations require authentication within the preceding ten minutes.
All write transactions recheck the session and account. Reauthenticate through `/login` when requested.

HTML lives under `/admin/{clients,users,audit,keys,settings}` and uses the existing server page style. No inline
scripts, no frontend build, no runtime dependencies. Responses are `no-store`; console pages have a restricted
CSP. Mutations are POST only, with exact issuer Origin and cookie/submitted CSRF matching the stored hash.

The API uses **the same scoped session**, including Origin and CSRF on every POST. It does not issue or accept a
standalone script bearer credential. This keeps the reviewed email roster and short admin scope authoritative,
with no new long-lived secret. Scripts may use the session cookie jar and CSRF value obtained from an actual
admin login; never put these in source control or logs. There is no cross-origin CORS permission.

| Method and `/admin/api/` path | Body / response |
| --- | --- |
| GET `clients` | `{clients:[...]}`; secret hashes excluded |
| GET `clients/:id` | Public client configuration, plus `confidential` and integer `version` |
| POST `clients` | Create configuration below; returns `{client,client_secret}` once |
| POST `clients/:id` | Partial configuration update with current `version`; id cannot change; stale version returns 409 |
| POST `clients/:id/rotate-secret` | `{}` for confidential clients; public clients require `{make_confidential:true}`; returns `{id,client_secret}` once |
| GET `users?q=email-or-id&before=id` | `{users,next}`; 50 rows per page |
| GET `users/:id` | Identities, up to 100 most recent sessions and grants, status and unchanged subject |
| POST `users/:id/block`, `unblock`, `delete` | `{}` |
| POST `users/:id/revoke-session` | `{sid:"..."}`; only this user/session, with durable logout and audit; grants unchanged |
| POST `users/:id/merge` | `{surviving_id:"...",confirm_source_email:"source@example.com"}` |
| GET `audit?actor=id&target=id&before=row-id` | `{audit,next}`; newest first, 50 per page |
| GET `keys` | Public key metadata, activation/retirement and status; no sealed/private JWK |
| POST `keys/rotate` | `{}`; new kid and activation timestamp |
| GET `settings` | Turnstile state, rate-limit configuration description and pending delivery counts |
| GET `branding` | `{branding, version}` for the realm |
| POST `branding` | `{branding, version}`; validated and contrast-checked; stale version returns 409 ([Branding](BRANDING.md)) |
| POST `branding/assets` | `{content_type, data}` (base64, at most 256 KiB); returns `{id, url}` |

The Branding page (`/admin/branding`) edits the realm's branding and previews any app's sign-in page at
`/admin/branding/preview?client=<id>`.

JSON POSTs use `Content-Type: application/json`, `Origin: https://id.vibernt.ai`, the session/CSRF cookies and
`X-CSRF-Token`. A `csrf` body field is also accepted. HTML forms use the same actions without `/api`.

Example Touchstone registration body (replace example hosts with the actual app origins):

```json
{
  "id": "touchstone",
  "redirect_uris": ["https://touchstone.example/auth/callback"],
  "post_logout_uris": ["https://touchstone.example/signed-out"],
  "backchannel_uri": "https://touchstone.example/auth/backchannel-logout",
  "signup_policy": "invited",
  "sign_in_methods": ["email", "github", "google"],
  "branding": {"name": "Touchstone"}
}
```

New clients are confidential. The server generates a random secret and stores only its SHA-256 digest. Neither
secret nor digest appears in later reads or audit. Allowed extra configuration: `dev` (0 or 1), `allowed_domains`,
`google_hosted_domains`, `agent_access`, `agent_registration_methods`, `agent_allowlist`, `agent_scope_catalogue`,
`agent_resource_prefixes`, `agent_max_grant_days`. Lists/objects use JSON in HTML textareas. A back-channel HTTPS
URI is mandatory for console/API client creation and editing. Signup defaults to invited and agents default off.
Settings are read-only: Turnstile and binding limits require deployment changes, and D1 budgets are code constants.
There is no settings write endpoint or unaudited settings mutation.

Client edits require the integer `version` returned by GET; the HTML editor carries it as a hidden input.
A transaction-time version assertion prevents concurrent read/merge/write from overwriting another edit.
Missing/malformed versions return 400; changed versions return 409 with no update audit. Reload and reconcile
before submitting again. Every edit or secret rotation increments the version. Secret rotation on a public
client requires explicit JSON boolean `make_confidential:true` or the console checkbox; this changes token
endpoint authentication. `admin_client_secret_rotate.detail.made_confidential` records whether it converted.
The new secret is still returned only once; rotation invalidates the prior secret immediately.

Merge first opens a read-only review page naming both source and survivor emails and IDs. Its final form
requires retyping the source email. The POST API enforces the same exact `confirm_source_email` match and
rechecks the source email inside the transaction. The source is deleted into `surviving_id`, never the reverse.
Admin roster comparisons and pending magic-link removal are case-insensitive. The offline importer already
normalizes new active/blocked email imports and rejects duplicate normalized addresses. Malformed path
percent-encoding produces a 400 response for authenticated admin requests.

## Blocking and durable delivery

Block/delete change user status, revoke every grant, remove all identity sessions and outstanding magic links,
deny approved device codes, and append the admin audit event in one D1 transaction. Code/token/consent issuance
checks current account state again at its transaction boundary. Unblock only changes `blocked` to `active`; it
never restores grants, sessions, codes or consumed links. Deleted/merged users cannot be unblocked.

At human token exchange, `app_sessions` records `(client_id,user_id,sid)`. It intentionally outlives identity
session and UserInfo expiry, but expires 30 days after creation. Block/delete capture **unexpired**
associations in `logout_outbox` before clearing them, one event per client. A single session retains its sid;
multiple sessions for one client produce a subject-wide token without sid. Normal logout and admin session
revocation capture only their sid. Merge ends both users'
sessions/grants, moves provider identities to the surviving id, and marks the source deleted with `merged_into`.
Same-user, self-admin, missing/inactive survivor and same-provider conflicts fail; races roll back atomically.
App memberships, data and principal projections are not merged by identity.
A linked GitHub/Google identity can sign into the survivor even when its provider email remains on the deleted
source. A matching tombstone merged into the linked user, or deleted without a merge target, is not an account
conflict. A different live/blocked owner or tombstone merged elsewhere still refuses sign-in.

Both human and agent events dispatch immediately after the mutation. The existing logout queue carries stable
event IDs; the every-minute cron recovers unsent/unacknowledged events. Dispatch pages through the entire backlog,
100 events per page. The consumer signs at delivery, POSTs without following redirects, has a ten-second timeout,
and retries in ten seconds. Queue batch timeout is one second. Five queue retries then DLQ do not discard the
source outbox: unacknowledged rows remain eligible for minute recovery. Successful delivery records `delivered_at`;
duplicate consumed messages acknowledge without another POST. A lost response can still cause a repeated POST,
so receivers must atomically deduplicate the stable `jti` and apply the effect, then return **2xx on duplicates**.
An event that remains undelivered 24 hours after creation becomes `expired` and is never signed or delivered.
The dispatcher expires old rows before enqueueing; a late queue message is acknowledged without delivery. Each
expiry creates one `backchannel_expired` audit row with client ID, event kind and event ID. The original last error
is retained, or a delivery-window error is recorded. Receivers must retain replay IDs for at least 24 hours plus
the event token lifetime and permitted clock skew: 120 seconds for human logout, 300 seconds for agent revocation.

Human requests contain `logout_token` with `iss`, app `aud`, `sub`, `sid` where known, stable `jti`, `iat`, `exp`
and `events:{"http://schemas.openid.net/event/backchannel-logout":{}}`. The JWT is ES256, `typ=logout+jwt`, valid
120 seconds, without nonce. This follows [OIDC Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html).
Agent events keep the existing `revocation_token` contract. The 0.2.0 SDK provides `verifyLogoutToken`, `verifyRevocationToken`, and `verifyBackchannel(form)` to dispatch
both fields at one URI, plus the existing request handlers. All verify only; durable deduplication/application
remains with the app. See the [package handler example](https://github.com/Vibernt/imprim/blob/main/packages/imprim-client/README.md).

The action response confirms local revocation, explicitly labels delivery asynchronous, and Settings shows pending
counts/oldest timestamps and clients missing a destination. A missing URI or failed dependency does not acknowledge
delivery. Every delivery attempt resolves the client's **current** `backchannel_uri`, so corrections apply to existing
pending events. The captured outbox `uri` is diagnostic only. With no current URI, `delivery_state` becomes
`missing_uri`, no HTTP request is sent and the event stays pending for retry. Success sets it to `delivered`.
Each client page and `GET /admin/api/clients/{id}` show undelivered and expired counts and events with the last error.
Settings lists missing current destinations across both outboxes, even if the captured URI was populated.
No alternate queue, provider or direct-network delivery path is used.

**Agent access bound:** newly minted access JWTs live at most **60 seconds**, also capped by grant expiry. The SDK
requires that maximum lifetime and rejects at `exp` without expiration leeway. Future `iat` and `nbf` allow
60 seconds by default; `verifyAccessToken(token,{audience,clockSkewSeconds})` accepts integer skew from 0 to 60. Refresh stops immediately. With
synchronized clocks and verification on every request, the worst remaining offline access is 60 seconds after a
block, independent of queue health. Apps must not cache a successful authorization beyond token expiry or use a
positive expiration tolerance. An already running app operation/stream needs its own deadline or reauthorization.
This is an intentional M4 replacement of the M2 900-second contract, with no compatibility period.

Human app-session delivery cannot be guaranteed within a minute during a queue, network or receiver outage.
The healthy-path target is under one minute; it must be measured after deployment. Local tests demonstrate state
changes, dispatch, retries and receiver behavior, not a Cloudflare or Assay production latency guarantee.

## Rotation and audit

Rotate now commits a new sealed ES256 key and its audit event. JWKS exposes the public key immediately, and
signing starts **one hour later**, matching PLAN.md's publication window. Another pending rotation is refused.
The preceding healthy key remains public for at least 24 hours after replacement, longer than the longest token
(ten minutes). `0003.retired_at` is retained; `verification_until` distinguishes healthy retired keys from existing
unreadable-key recovery. Clients cache keys and refresh once on an unknown kid; no stale verification is invented
if a fetch fails. The rotation test covers JWKS before rotation, preactivation and postactivation, real signatures,
client unknown-kid refresh and eventual retirement.

Every successful admin action and audit row commit together, with actor, target and non-secret detail. Client edits
record changed field names, including all redirect/logout/back-channel URI changes; they do not log URI query
strings. Audit remains append-only under the existing triggers. Filters use dedicated actor/target indexes.

## Migration and verification

`0005_control_plane.sql` adds app associations and their creation-time index, logout outbox, delivery acknowledgment on the agent outbox,
admin scope expiry, audit target/indexes, key verification retention, and an empty transaction-assertion table whose
CHECK constraint aborts unsafe batches. There is no old session/grant migration. Apply before the new Worker.
`0006_security_review.sql` adds client versions, outbox delivery states and retention indexes. Apply it after
`0005` and before running this revision of the Worker.
`0007_backchannel_expiry.sql` adds outbox last errors and expiry indexes. Apply it after `0006`.

Scheduled maintenance removes at most 500 rows per outbox per invocation, only when `delivered_at` is more than
30 days old. This preserves a month for incident diagnosis and delayed queue replay review, exceeding the
seven-day minimum. Pending/missing-URI rows and the append-only audit log are never pruned by this cleanup.

App-session associations expire 30 days after creation. Scheduled maintenance removes at most 500 expired
associations per run; fan-out filters them at capture time even when cleanup has not run. Apps must end sessions
minted from identity sign-in within 30 days; Assay uses seven days. Identity-session expiry alone does not remove
a younger association.

Local coverage: real SQLite transactions; Worker request smoke tests; HTML form submission/escaping/security
headers; admin boundaries; all grant paths blocked; concurrent mutation checks; merge refusal; audit rollback;
secret non-disclosure; fake signed receivers with persisted replay IDs; queue/receiver outage; >100 events;
key overlap and client artifact parity. Native-browser visual interaction and production bindings are untested.
