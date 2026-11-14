# M4 implementation report — 2026-11-06

Worktree a separate worktree, branch `m4-control-plane`. Implementation is local; production exit
criteria remain contingent on app integration and hosted checks below. No commit, push, deploy, secret change,
or Assay repository modification was performed.

## Decisions

- **60-second agent JWTs**, strict expiry without positive expiration tolerance, no compatibility path for 900-second
  tokens. Refresh and identity sessions stop at the block transaction. Worst remaining offline JWT validity:
  60 seconds with synchronized clocks and validation on each request. In-progress requests/streams need app deadlines.
  The existing revocation event still delivers durable grant notifications. Apps must use the rebuilt verifier.
- **Admin scope on an identity session:** only standalone administrator email-link verification grants one hour of
  admin scope; normal app sessions and provider sessions do not. Roster/status checked every request. Destructive
  actions require ten-minute freshness, and write transactions fence session/account changes.
- **API authentication:** the same scoped session, Origin and CSRF for scripts and browser clients. No bearer
  credential or separate secret introduced. The API can register Touchstone now once the Worker is deployed.
- **Healthy key rotation:** publish immediately, activate after one hour, retain the preceding public key for at
  least 24 hours. This follows the approved publication window; “Rotate now” begins that rotation, not immediate signing.
- **Merge:** source becomes deleted/merged; survivor id stays unchanged, provider identities move, both accounts'
  sessions/grants end. Same-provider collisions are refused, including transaction races. App data/memberships stay
  under app ownership. Self-admin destructive actions are refused.
- **Delivery:** durable human and agent outboxes, immediate dispatch, minute recovery, ten-second retry, parallel
  queue batch handling, durable delivery acknowledgment. Stable `jti` lets receivers deduplicate a lost acknowledgment.
  Unreachable/unconfigured receivers stay pending and visible. An outage has no guaranteed human-session deadline;
  hosted under-one-minute propagation is an explicit remaining gate.
- **Settings:** read-only because Turnstile/binding limits are deployment configuration and D1 budgets are constants.
  Consequently no settings mutation endpoint exists. All implemented admin writes and admin sign-in are audited.

## Files

Added:

- `apps/server/migrations/0005_control_plane.sql`: associations, human outbox, agent delivery status, admin session
  expiry, audit target/indexes, healthy-key verification retention, transaction assertions and lookup indexes.
- `apps/server/src/admin/{auth,clients,users,pages,routes}.mjs`: small auth/action/page/API modules.
- `apps/server/src/oidc/backchannel.mjs`, `apps/server/src/services/outbox.mjs`: logout construction, delivery,
  shared durable dispatch and pending status.
- `tests/admin.test.mjs`, `tests/admin-users.test.mjs`, `tests/admin-boundaries.test.mjs`,
  `tests/admin-rotation.test.mjs`, `tests/support/admin.mjs`: control-plane smoke/integration/negative tests.
- `docs/CONTROL_PLANE.md`, this report.

Modified:

- `apps/server/src/auth/{magic,session}.mjs`: explicit email-only admin scope and atomic sign-in audit.
- `apps/server/src/oidc/{token,requests,logout,keys,discovery}.mjs`: app association capture, transaction fencing,
  durable logout, rotation/retention, advertised back-channel support.
- `apps/server/src/agents/{grants,revocation}.mjs`: 60-second lifetime and durable acknowledgment/recovery.
- `apps/server/src/services/maintenance.mjs`, `apps/server/src/worker.mjs`, `apps/server/wrangler.jsonc`: routing,
  delivery scheduling, queue processing; `pages/layout.mjs`: wrapping/scrolling for admin fields.
- `packages/imprim-client/{index.mjs,index.d.ts,resources.mjs,README.md}`: lifetime/expiry validation, stricter logout
  validation, verified agent-revocation helper and API types. Rebuilt ignored `dist/imprim-client.mjs`.
- Existing `tests/{agents-flow,agents-races,scaffold}.test.mjs`: revised lifetime/scheduling assertions.
- `PLAN.md` and `docs/{PROTOCOL,CONFIGURATION,ARCHITECTURE,SECURITY,AGENT_ACCESS,CLIENTS,OPERATIONS,PORTING}.md`:
  M4 contracts and current scheduling/lifetime.

## Assay changes for the owner — precise handoff

Inspected read-only in the Assay repository; the items below are required changes, not completed work.

1. **`src/auth/imprim-client.mjs`**: replace with identity's rebuilt `dist/imprim-client.mjs`, unchanged. The artifact
   header includes its body SHA. Run `scripts/imprim-client-check.mjs` through Assay's check command and extend
   `tests/imprim-client-check.test.mjs` / `tests/identity-resource.test.mjs` to assert a 60-second token is accepted,
   a 61-second token is refused, and expiry at exactly `exp` is refused. `identityActor` in
   `src/auth/identity-access.mjs` must continue verifying every request; never cache permission past token expiry.
2. **`src/auth/identity-login.mjs`, `backchannelLogout`**: it currently returns 409 for a stored `jti`. Return 204 for
   an authenticated duplicate without reapplying deletion. Preserve atomic insert+effect and fail actual database
   errors. Extend `tests/identity-sign-in.test.mjs` to simulate receiver success with lost response, retry, one effect,
   two successful acknowledgments, and a newly created session remaining intact on duplicate receipt.
3. **Agent notifications on the same registered endpoint**: add `src/auth/identity-backchannel.mjs` with
   `handleIdentityBackchannel(request,env)`; route `/auth/backchannel-logout` in `src/api/app.mjs` to it. Bounded-read the
   form and require exactly one of `logout_token` or `revocation_token`. Human tokens use `handleBackchannelLogout`;
   agent tokens use the new SDK `handleAgentRevocation`. Verify first, atomically store/deduplicate the signed `jti`
   and record `(grant_id,sub,resource)` for revocations, then return 204. Agent revocations must not erase all human
   sessions. Add `tests/identity-backchannel.test.mjs`: wrong issuer/audience/event/type, tampering, expired tokens,
   both form fields, duplicates, and transactional rollback. Identity JWTs lack grant_id by design, so notification
   receipt does not imply per-grant offline token rejection; the 60-second expiry is the selected access bound.
4. **Delayed callback fence**: add a new Assay migration (do not rewrite `0067_identity.sql`) with
   `identity_logout_sids(sid TEXT PRIMARY KEY, principal_id TEXT NOT NULL)` and `sessions.identity_sid TEXT` plus index,
   and a table for the grant notifications above. In `backchannelLogout`, persist the signed sid with the event and
   delete matching sid/subject sessions in the same transaction. In `finishIdentityLogin`, pass verified `claims.sid`
   to `issueSession` (`src/auth/session.mjs`). Make issuance an atomic INSERT…SELECT that refuses a logout sid;
   reject if no row was inserted. This closes logout arriving between code exchange and app-session creation.
   Preserve membership/admission/subject checks. Test both orderings: callback commit before logout and logout
   commit before callback. A new identity sign-in after unblock has a different sid and must work. Identity emits
   sub and sid for every association; keep subject-wide handling for valid sub-only events, with an auth-time cutoff
   if supporting that external case. Retain sid fences while corresponding identity sessions could be reused.
5. **Registration**: configure Assay's client `backchannel_uri` to its real HTTPS `/auth/backchannel-logout` endpoint.
   Confirm that routing on that host reaches the handler directly without a console redirect. Verify no authorization
   or membership rule has been moved into identity.

Suggested Assay schema identifiers above are new; the existing files/functions were verified in the read-only
source. No Assay tests were executed and no Assay files were edited.

## Touchstone

Register the actual redirect/post-logout/back-channel URIs with `/admin/api/clients` or the console, following
`CONTROL_PLANE.md`. Store the returned secret in Touchstone's approved secret workflow. Implement browser state,
nonce and PKCE transaction binding, local sessions with identity sub/sid, verified event handling with atomic jti
deduplication and the same delayed-callback fence as Assay. Install the updated imprim-client package/artifact.
Keep tenant tokens/memberships and authorization local. No Touchstone source was inspected or modified.

## Validation and remaining checks

Commands completed successfully:

```text
npm run test:quiet
426 tests: 426 passed, 0 failed, 0 skipped

npm run check
Checked 91 ESM files; syntax and zero runtime dependencies.

git diff --check
(no errors)
```

The 368-test baseline now has 58 additional tests. `node scripts/build-client.mjs` rebuilt the ignored artifact;
version `0.1.0`, body SHA-256 `081754e74848b8d6423deb2cba688954ea85e45d9f250d03c599bc3bf0fbc39e`.
The artifact parity test passes. No runtime dependency or frontend build was introduced.

Tests use the real SQLite D1
harness and controlled dependencies, including fake back-channel receivers. Coverage includes HTML responses and
form submission, but no native-browser visual or mailbox test was run. User detail intentionally limits sessions
and grants to the latest 100; user search and audit are paged. This is not an unlimited historical-session browser.

After an owner-authorized deployment:

1. Apply `0005`, deploy Worker, verify minute cron, queue batch settings, consumer and DLQ; configure every RP's
   back-channel URI. Check pending/oldest outbox counts and deliberately exercise a failed receiver and recovery.
2. Complete a real admin magic link in Chrome and Safari. Check scope expiry, reauthentication, Origin/CSRF,
   CSP, no-store, one-time secret display and Touchstone client registration.
3. With live sessions on every app/browser and live agent grants, block once. Measure identity denial immediately,
   app session denial under 60 seconds, refresh/device/pending-code denial, and offline JWT denial by 60 seconds.
   Verify recipient jti persistence, replay acknowledgment and no callback resurrection. Unblock must require new
   sign-in and new agent consent. Repeat delete/merge with synthetic accounts.
4. Rotate a live key. Observe JWKS publication, hour-later activation, warm/cold and unknown-kid client verification,
   old/new overlap, and retention through the last old token expiry. Inspect audit actor/target without secrets.
5. Run Assay and Touchstone's own regression suites and hosted session tests. Identity's fake receivers do not prove
   those integrations. Check real D1 race behavior and queue delivery latency; no local test establishes those SLAs.

Next best action: review the local diff and apply the specified Assay receiver/session changes before authorizing
M4 deployment and the timed production exit checks.

## Part 3 security-review update

The subsequent [M4_PART3_REPORT.md](history/M4_PART3_REPORT.md) records security fixes and current verification.
Current admin requests require merge source-email confirmation and client edit versions; public-client
secret rotation requires explicit conversion. Pending delivery uses the current destination, and delivered
outbox rows have bounded 30-day retention. Apply `0006_security_review.sql` after `0005` for this revision.
See [CONTROL_PLANE.md](../CONTROL_PLANE.md) for current behavior and the pending app-session expiry decision.
