# M4 part 3 — security review fixes

Worktree a separate worktree, branch `m4-control-plane`, 2026-11-06. Built on the existing
uncommitted M4 parts 1 and 2. All six primary findings are fixed. The mixed-case comparisons, malformed admin
paths and delivered-outbox retention are fixed. Automatic app-session expiry remains a policy decision below.
No commit, push, deployment, secret change, Assay edit or Touchstone edit was performed.

## Findings and regression coverage

| Finding | Fix | Test |
| --- | --- | --- |
| 1. Provider sign-in after merge | A provider identity moved to the survivor accepts the source email's tombstone when `merged_into` equals the linked user. Deleted rows without a merge target are also not conflicts. Live/blocked different owners and merges elsewhere still fail. | `github.test.mjs` and `google.test.mjs`: create source through provider callback, merge, repeat callback and exchange code; ID token `sub` is survivor. Existing live-account conflicts remain covered. `provider-merge-boundaries.test.mjs` adds deleted, blocked, different-target and mixed-case conflicts for both providers. |
| 2. Destructive merge direction | User page says “Merge this user into another: this user is deleted”. Read-only review page names source and survivor emails/IDs. Final form requires retyping source email. API and HTML POST require exact `confirm_source_email`; source email is fenced in the mutation transaction. | `admin-security.test.mjs`: missing/empty/wrong/survivor confirmation refuses without mutation/audit; review is read-only, both emails visible, wrong HTML confirmation refuses, correct confirmation merges. Existing merge/conflict/race tests now submit the confirmation. |
| 3. Access-token clock skew | `verifyAccessToken(token,{audience,clockSkewSeconds})` defaults to 60 seconds for future `iat`/`nbf`; only integers 0–60 allowed. Expiry remains exact and maximum token lifetime stays 60 seconds. Type declaration updated. | `agents-client.test.mjs`: both claims at/beyond default and custom limits, zero skew, invalid settings, and exact expiry with maximum skew. Existing source/bundle parity and real server-token tests pass. |
| 4. Captured outbox destinations | Both consumers read the client's current URI on every attempt. Captured `uri` stays diagnostic. No current URI means no HTTP request, `delivery_state='missing_uri'`, no acknowledgment, retained event. Settings reports current missing destinations from both outboxes. | `server-backchannel.test.mjs`: both event types park with no current URI; update via admin client API; pending events POST to corrected URI and mark delivered while captured URI stays unchanged. Exact part-2 wire assertions still pass. |
| 5. Lost client edits | Integer `clients.version` returned by GET and carried in hidden console field. Edits require it; transaction-time assertion and versioned UPDATE fence the complete read/merge/write. Rotation increments version too. Missing/malformed version is 400; stale version is 409, with no update audit. | `admin-security.test.mjs`: concurrent edits have one winner, winner's values survive, one audit, stale API/form rejection. `admin-client-races.test.mjs`: secret rotation between edit read/commit aborts edit; audit failures roll back configuration/secret/version. |
| 6. Public-client secret rotation | Public clients require explicit boolean `make_confidential:true` or the labeled console checkbox. Ordinary rotation cannot silently change authentication. Audit detail records `made_confidential`; generated secrets remain show-once. | `admin-security.test.mjs`: absent/false/string choices refuse without secret or audit, explicit conversion succeeds and invalidates stale editor. `admin-client-races.test.mjs`: HTML omission/false refuses, checked conversion succeeds; audit rollback. |
| Mixed-case email | Admin roster comparison lowercases supplied email; block/delete/merge magic-link removal lowercases both stored sides. Import already lowercases active/blocked emails and rejects normalized duplicates, so no import behavior change was needed. | `admin-security.test.mjs`: capitalized stored admin retains access; blocking capitalized account deletes differently cased pending links. `provider-merge-boundaries.test.mjs`: linked capitalized administrator still cannot use either provider. Existing `import.test.mjs` verifies normalized imports and stable subject IDs. |
| Malformed admin path | Catch URI-decoding failure and return 400. | `admin-security.test.mjs`: malformed percent and UTF-8 encoding on authenticated HTML/API routes return 400. |
| Outbox retention | Scheduled maintenance deletes at most 500 rows per outbox per run when delivery is more than 30 days old. Pending rows and append-only audit remain. Indexes support bounded oldest-first deletion. | `maintenance-retention.test.mjs`: 505 old rows require two sweeps; pending, seven-day and exact 30-day rows survive in both tables. |

The initial regression run preceded fixes: 13 failures / 81 tests. One of those failures was an invalid
magic-link fixture column; after correcting that fixture, its test was rerun against the original comparison
and failed with two retained links instead of zero. The two retention tests were also run before cleanup and
failed. All regression tests now pass. Additional boundary/rollback tests were then added.

## App-session expiry decision still required

`app_sessions` contains `(client_id,user_id,sid,created)`, no `expires_at`. The approved M4 contract explicitly
preserves these associations beyond identity-session expiry because each app owns its local session lifetime.
An expired identity session does not establish that an app session expired. Deleting its association on that
basis can silently disable later block/delete delivery to the app.

No expiry or app maximum lifetime has been invented. The pending question asks the owner to choose:

- Retain associations until explicit logout/revocation/block/delete/merge (current behavior), with bounded
  delivered-outbox cleanup implemented here; or
- Define a 30-day association lifetime from the latest code exchange, with apps required to enforce that
  maximum too, then implement indexed expiry and bounded cleanup.

An explicit app expiry-reporting contract would be another design choice. The current task does not edit apps.
`maintenance-retention.test.mjs` additionally proves scheduled identity-session expiry retains the association,
which can still produce a later logout event. Automatic app-session expiry cleanup is **not implemented**;
this is the remaining requested work, pending the lifetime decision rather than a technical test failure.

## Migration and client artifact

Apply `0006_security_review.sql` after `0005_control_plane.sql` before this Worker revision. It adds client
versions, persistent outbox delivery states and retention indexes. No migration was applied to a remote database.

Rebuilt using `node scripts/build-client.mjs`; version stays **0.2.0**, unreleased:

```text
Built imprim-client 0.2.0 ff21e73cb33b2038b3772ee36c3d0403384edc4b566282b7283bbde4884cf2c1
```

Independently recomputed SHA-256 of everything after the first header newline matches. Artifact:
`dist/imprim-client.mjs` (still ignored). `docs/M4_PART2_REPORT.md` now points to the current body hash;
its final back-channel wire-format table is unchanged. No token field, header type, event key, audience,
logout/revocation lifetime or form field changed in part 3.

## Verification

```text
npm run test:quiet
499 tests: 499 passed, 0 failed, 0 skipped

npm run check
Checked 103 ESM files; syntax and zero runtime dependencies.

git diff --check
(no errors)
```

Changed executable behavior has local regression/negative coverage. Tests use real SQLite transactions and
Worker request/HTML smoke tests, with fake provider/network responses. New modules are small and grouped under
server services; no runtime dependency or frontend build was added.

Unexecuted: native-browser interaction/visual QA, live GitHub/Google authentication, hosted D1/Queue/DLQ/cron
qualification and latency, live Assay/Touchstone receivers, and TypeScript compiler validation of declarations.
No production success is claimed. The migration was exercised by the local SQLite test harness only.

Next best action: settle the app-session lifetime decision, finish its bounded cleanup if a lifetime is chosen,
then review the combined uncommitted M4 changes and qualify the actual app receivers under separate authorization.
