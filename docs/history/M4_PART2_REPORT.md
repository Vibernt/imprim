# M4 part 2 — logout lifetime and imprim-client 0.2.0

Completed locally on 2026-11-06 in a separate worktree, branch `m4-control-plane`.
The existing uncommitted M4 control plane remains in place. No commit, push, deployment, secret change, Assay edit,
or Touchstone edit was made. Assay's existing client was imported read-only for compatibility verification.

## Final wire formats

Both tokens use the current ES256 signing key and the same published JWKS as ID tokens. Both are sent by POST with
`Content-Type: application/x-www-form-urlencoded` to the registered `backchannel_uri`.

| Contract | Human logout | Agent-grant revocation |
| --- | --- | --- |
| Form field | `logout_token` | `revocation_token` |
| Header | `{alg:"ES256",typ:"logout+jwt",kid}` | `{alg:"ES256",typ:"JWT",kid}` |
| Claims | `iss`, scalar client-id `aud`, `sub`, optional `sid`, integer `iat`, `exp=iat+120`, stable event-id `jti`, `events` | `iss`, scalar client-id `aud`, `sub`, integer `iat`, `exp=iat+300`, stable event-id `jti`, `grant_id`, `resource`, `events` |
| Exact events value | `{"http://schemas.openid.net/event/backchannel-logout":{}}` | `{"https://id.vibernt.ai/events/agent-revoked":{}}` |
| Nonce | Never emitted; refused by verifier | Never emitted; refused by verifier |

Logout lifetime is now **120 seconds**, reduced from the prior uncommitted M4's 300 seconds. Revocation's type and
300-second minting lifetime are unchanged. Both client event verifiers enforce a maximum lifetime of 900 seconds,
exact scalar audience and issuer, one empty event object, signature and required claims. Revocation additionally
checks the canonical resource against configured `resourcePrefixes`. Future `iat`/`nbf` skew defaults to 60 seconds
and may be reduced to 0; values outside 0–60 are rejected. Expiration has no positive leeway.

Logout is captured transactionally on `/logout`, admin block/delete, admin session revocation and merge. Merge
retains M4's reauthentication behavior for both disappearing and surviving users, and includes the disappearing
user's original `sub`. There is one logout event per affected client: retain `sid` when one session is affected;
omit `sid` when an account-wide action affects multiple sessions of that client, making it subject-wide logout.
Normal logout and admin single-session revocation remain scoped to their sid.

Added `POST /admin/api/users/:id/revoke-session` with `{sid}`, and the corresponding HTML action. Existing admin
scope, Origin, CSRF and recent-authentication checks apply, with a transaction-time authorization fence. Session
removal, outbox capture and audit commit together; other sessions and separately approved agent grants remain.

Delivery retains the durable outboxes, immediate enqueue plus minute recovery, ten-second timeout,
`redirect:'manual'`, rejection of redirects/non-2xx, retries and configured five-retry dead-letter routing. The
consumer suppresses already-delivered event IDs. A lost response can repeat delivery, so receivers must persist
`jti` and effects atomically and acknowledge authenticated duplicates with 2xx. Outbox rows remain eligible for
recovery even after queue retries reach the DLQ; local tests do not prove hosted queue behavior.

## Client and artifact

New named exports and client-instance methods:

- `verifyLogoutToken(token, options)` → `{sub, sid, jti, iat, exp}`.
- `verifyRevocationToken(token, options)` → `{sub, jti, grantId, resource, iat, exp}`.
- `verifyBackchannel(form, options)` → `{kind:'logout'|'revocation', claims}`. It rejects absent, duplicate,
  mixed-kind and file-valued token fields.

Named functions take issuer/client configuration; instance methods reuse the configured issuer/client/resource
prefixes and JWKS cache. Unknown signing-key IDs refresh once, rate-limited to one refresh per minute. Existing
`handleBackchannelLogout` and `handleAgentRevocation` remain, with their original return shapes and stricter validation.
Types and a durable receiver integration example are in the [package README](https://github.com/Vibernt/imprim/blob/main/packages/imprim-client/README.md)
and `index.d.ts`. JWT verification and event handling are in small separate modules.

Current build output after part 3 security fixes (version remains unreleased 0.2.0):

```text
Built imprim-client 0.2.0 ff21e73cb33b2038b3772ee36c3d0403384edc4b566282b7283bbde4884cf2c1
```

This is the SHA-256 of the body after the first header line, not the hash of the whole file. The rebuilt file is
`dist/imprim-client.mjs`; `dist/` remains ignored by the existing repository configuration. The package remains
private and has not been published to npm.

## Access-token bound and required app changes

Agent access tokens retain the previous M4 choice: **at most 60 seconds**, shortened at the grant deadline.
Refresh is refused immediately after revocation. The 0.2.0 access verifier rejects at `exp` without positive leeway.
With synchronized clocks and verification on every request, no back-channel or introspection is required for the
one-minute limit. Apps must not cache admission past token expiry.

**Additional access-token claim:** this part adds and requires nonempty `grant_id` in `at+jwt` tokens. Previously
an app could not identify which grant a token belonged to, so it could not implement the requested precise denial.
The two back-channel wire formats above have not changed beyond the requested logout lifetime. Applications check
a durable denial keyed by `(sub, aud, grant_id)`; a revocation event provides `(sub, resource, grantId)` for that key.
Human UserInfo opaque tokens and ID tokens still have their separate 600-second lifetime.

| App | Exact adoption work |
| --- | --- |
| Assay | Replace `src/auth/imprim-client.mjs` with this worktree's rebuilt `dist/imprim-client.mjs`. Update the vendor integrity check to version `0.2.0` and the body hash above. Replace logout-only receiver dispatch with `client.verifyBackchannel(form)` at the registered back-channel URI. |
| Touchstone | Update its package/local dependency to `imprim-client` version `0.2.0` using the agreed private distribution source; no npm release happened here. Import/use `createClient` and `client.verifyBackchannel(form)` at its registered back-channel URI. |
| Both | Configure the app's actual `clientId`, issuer and `resourcePrefixes`. Atomically dedupe `jti` and either end sessions matching `sub`/`sid` (all for `sub` when sid is absent), or persist the precise grant denial. Return 2xx on success/authenticated duplicates. On every agent request verify exact audience/expiry and check the denial tuple before normal membership/scope checks. Never acknowledge failed persistence or verification. |

Rollout order: first deploy the identity server emitting `grant_id`, then switch app verifiers to 0.2.0 after the
old access-token lifetime has elapsed. On this M4 server that is 60 seconds; any production issuer still minting
older 900-second tokens must account for that older lifetime. Tokens without `grant_id` are intentionally refused
by 0.2.0; there is no compatibility fallback. No rollout was performed by this task.

## Verification

```text
npm run test:quiet
469 tests: 469 passed, 0 failed, 0 skipped

npm run check
Checked 97 ESM files; syntax and zero runtime dependencies.

git diff --check
(no errors)
```

Additional read-only compatibility run:

```text
ASSAY_IDENTITY_CLIENT_PATH=<assay checkout>/src/auth/identity-client.mjs node --test tests/server-backchannel.test.mjs
6 tests; 6 passed; 0 failed; 0 skipped
```

The Assay copy's whole-file SHA-256 at verification was
`1934f284fc97b950049d2e50ab55eef845621e54ec0dcb917b5e3ad3bdf484db`.
The logout test also explicitly asserts the promised typ, claims, event, absence of nonce and lifetime <=900,
independently of what that older copy enforces.

Coverage includes every requested verifier negative, successful and unsuccessful unknown-kid refresh, prefix
segment/origin boundaries, bounded skew and exact expiry, source/bundle parity, server-minted tokens, duplicate
delivery, redirect/non-2xx/injected timeout failure, durable precise grant denial, and protected session revocation
including audit-failure rollback. Existing tests cover logout/block/delete/merge, durable queue failure/recovery,
key rotation and other protocol boundaries. Updated two older assertions to use the error code and the new
900-second verifier cap; the server's revocation minting lifetime remains 300 seconds.

Unexecuted: live Assay/Touchstone receiver integration, hosted Cloudflare delivery/timeout/retry/DLQ and measured
production propagation; browser automation for the new button; TypeScript compiler validation of declarations.
The new button has HTTP/HTML smoke coverage, and SDK/server behavior has local negative/smoke coverage. Documentation
examples describe an app-owned durable store; that store must be implemented and tested in each app separately.

## Files changed by part 2

These are this task's changes layered onto the earlier uncommitted M4 work, not a claim that all working-tree
changes originated here.

| Area | Files |
| --- | --- |
| Server | `apps/server/src/oidc/backchannel.mjs`; `apps/server/src/agents/grants.mjs`; `apps/server/src/admin/sessions.mjs` (new); `apps/server/src/admin/routes.mjs`; `apps/server/src/admin/pages.mjs` |
| Client | `packages/imprim-client/index.mjs`; `index.d.ts`; `package.json`; `resources.mjs`; `backchannel.mjs` (new); `jwt.mjs` (new); `README.md` |
| Build | `scripts/build-client.mjs`; rebuilt ignored `dist/imprim-client.mjs` |
| Tests | New `tests/client-backchannel.test.mjs`, `tests/server-backchannel.test.mjs`, `tests/admin-sessions.test.mjs`; updated `tests/admin-users.test.mjs`, `tests/admin-rotation.test.mjs`, `tests/agents-client.test.mjs`, `tests/imprim-client.test.mjs` |
| Design/docs | `PLAN.md`; `docs/PROTOCOL.md`; `docs/CONTROL_PLANE.md`; `docs/CLIENTS.md`; `docs/AGENT_ACCESS.md`; this report |

Next best action: apply the documented 0.2.0 receiver and grant-denial changes in each app under separate
authorization, then qualify delivery and the one-minute bound against the real deployed receivers before rollout.

## Part 3 security-review update

See [M4_PART3_REPORT.md](history/M4_PART3_REPORT.md) for the current verification and changes. The final wire-format
table above is unchanged. The current body hash above supersedes the original part-2 artifact. Part 3 restores
bounded configurable future `iat`/`nbf` skew for access tokens with strict expiry, and changes server delivery
to use current registered destinations. Admin merge confirmation, edit versions, public-client conversion and
maintenance behavior are documented in [CONTROL_PLANE.md](../CONTROL_PLANE.md). Verification counts in this part-2
report describe the original part-2 run, not the later security-review run.
