# Operations (M1 sign-in and M2 agent access)

A build of this repository serves `https://id.vibernt.ai`: discovery and JWKS answered on 2026-11-15. This
repository does not record which commit is deployed or which clients are registered there; check the Worker's
deployments in Cloudflare before relying on a behavior described here. Migrations `0008` (security pass) and `0009` (realms) are **not yet** deployed there; [Deploying](DEPLOY.md#upgrading-the-existing-vibernt-deployment-to-realms) has the upgrade.

## Local verification

Use Node >=22.13 with `node:sqlite` (validated here with Node 26). No install or build step is needed:

```sh
export PATH=/opt/homebrew/bin:$PATH
npm run test:quiet
npm run check
```

The suite uses real in-memory SQLite behind Assay's D1-shaped harness, and fake email/rate-limit bindings and HTTP
provider responses, including locally signed RSA Google ID tokens and fake token/JWKS endpoints. It creates no localhost listener and sends no emails. `check` validates ESM syntax and absence
of runtime packages/imports. Browser script smoke tests exercise fragment handling and explicit click behavior in
Node; they are not native-browser or Cloudflare runtime proof. Wrangler/workerd and OpenID conformance are separate
release gates, not represented by this suite passing.

## Provider registrations (2026-11-05)

These exist already; their secrets are set only through `wrangler secret put`.

| Provider | Registration | Notes |
|---|---|---|
| Cloudflare Turnstile | Widget `vibernt-identity`, hostname `id.vibernt.ai`, Managed, no pre-clearance | Site key in `wrangler.jsonc`; secret key on the widget page. |
| GitHub | OAuth app `Vibernt` in the Vibernt organization, callback `https://id.vibernt.ai/auth/github/callback` | Generate the client secret only when setting `GITHUB_CLIENT_SECRET`; GitHub shows it once. |
| Google | Project `vibernt-identity`, Auth Platform app `Vibernt` (External, Testing), Web client `id.vibernt.ai`, redirect `https://id.vibernt.ai/login/google/callback` | Logo is the Vibernt mark. While in Testing only listed test users can sign in; with a logo, publishing needs Google's brand verification. |

## Production order: no staging

1. The sign-in page loads the Turnstile script/frame only when both keys are configured. Its CSP allows that origin
   for scripts and frames; every HTML page otherwise uses same-origin assets and forbids inline scripts, foreign form
   posts and framing. With neither key configured (local/development), email sign-in is enabled without a challenge.
   With only one key configured, requests fail with `turnstile_config`. Every method enabled for a client must work
   before cut-over.
2. Provision D1 `vibernt-identity`, KV `CONFIG_CACHE`, Queue `vibernt-identity-logout` and its
   `vibernt-identity-logout-dlq`. Put the actual D1/KV IDs into `apps/server/wrangler.jsonc`. KV remains reserved; M2 metadata caching uses bounded D1 rows; review the rate-limit namespace ids for account-level uniqueness. M1 reads security policy from D1 on each flow, without stale cache admission.
3. Onboard the email sending domain and verify `EMAIL_FROM` (currently `signin@vibernt.ai`; vibernt.ai is already enabled and configured, 2026-11-05) through Cloudflare
   Email Service. This is the transactional `EMAIL.send({...})` binding, not legacy recipient-only routing.
   Verify sending authorization and real Gmail/Outlook/iCloud delivery separately.
4. Configure a Turnstile widget for `id.vibernt.ai`; set its public `TURNSTILE_SITE_KEY` and private `TURNSTILE_SECRET`.
   Do not use dummy test keys on the issuer. GitHub OAuth callback: `https://id.vibernt.ai/auth/github/callback`;
   the OAuth client must support PKCE and `read:user user:email`. Set both GitHub secrets below.
   If siteverify is unavailable, a configured issuer logs `turnstile_degraded` and sends magic links only to existing
   active users, with separate limits of five requests per client IP and two links per address/client IP per hour.
   New users cannot use invitations, domains or open signup during the outage. Invalid tokens and rejected secrets
   remain failures. Verify this operational mode with existing and new accounts before cut-over.
5. Configure the realm and its admin roster in D1 with `scripts/realm.mjs` ([Deploying](DEPLOY.md)). Admins sign in
   by email link only; there is no admin bypass and no GitHub or Google admin sign-in.
6. Using an operator-installed, reviewed Wrangler version, apply D1 migrations, set secrets, enable the commented
   custom-domain route, and deploy the Worker **with the clients table empty**:

   ```sh
   wrangler d1 migrations apply vibernt-identity --remote --config apps/server/wrangler.jsonc
   wrangler secret put SEALING_KEY --config apps/server/wrangler.jsonc
   wrangler secret put GITHUB_CLIENT_ID --config apps/server/wrangler.jsonc
   wrangler secret put GITHUB_CLIENT_SECRET --config apps/server/wrangler.jsonc
   wrangler secret put GOOGLE_CLIENT_ID --config apps/server/wrangler.jsonc
   wrangler secret put GOOGLE_CLIENT_SECRET --config apps/server/wrangler.jsonc
   wrangler secret put TURNSTILE_SECRET --config apps/server/wrangler.jsonc
   wrangler deploy --config apps/server/wrangler.jsonc
   ```

   Secrets are prompted, never command-line literals or checked-in vars. `SEALING_KEY` is 32 cryptographically random
   bytes encoded as 64 hex characters. Keep a secure backup separate from the database backup. `workers.dev` and
   preview URLs are disabled; the Worker rejects any request host other than its configured issuer.
   If a sealed signing key cannot be opened, identity retires it, audits `oidc_key_unreadable`, and creates a new
   generation immediately. Retired keys are excluded from JWKS. Treat this event as an incident: investigate the
   sealing key and cached tokens, and verify live sign-in and JWKS before continuing rollout.
7. Export Assay principals and principal_identities offline. Keep the export/import outside Git (use ignored
   `exports/` and `imports/` directories). Run `node scripts/import-assay.mjs exports/assay.json > imports/assay.sql`.
   The exact JSON shape is documented in that script. It validates the entire input before printing SQL; it never
   makes network calls. Back up D1 and review the SQL before the operator applies it with the printed command.
   D1 owns transaction boundaries; do not assume the whole file applies atomically. A conflict may leave earlier
   idempotent statements applied: stop, inspect, resolve the conflict deliberately, and rerun. Never automatically
   overwrite a different subject/email or relink a provider id.
8. Verify counts, normalized unique emails, deleted statuses and identity mappings. `principals.id=users.id=sub`.
   Existing blocked/deleted identity users are not reactivated on reimport. Confirm operator email login at `/login`
   with zero clients and inspect discovery/JWKS. SQL sanity queries:

   ```sql
   SELECT status,COUNT(*) FROM users GROUP BY status;
   SELECT COUNT(*) FROM user_identities;
   SELECT lower(email),COUNT(*) FROM users GROUP BY lower(email) HAVING COUNT(*)>1;
   SELECT i.provider_id FROM user_identities i LEFT JOIN users u ON u.id=i.user_id WHERE u.id IS NULL;
   SELECT id FROM clients;
   ```

9. Register the Assay confidential client using reviewed exact callback/logout URLs and invited policy (CLIENTS.md).
10. Vendor the completed client library with its pinned version/SHA into Assay, replace Assay's human auth routes,
    preserve its principal projection and app-local authorization. Invalidate Assay's old human sessions once.
    Those cross-repository changes are outside this task and have not been made.
11. Before switching: pass OpenID basic-profile conformance; exercise real browser/mailer flows, replay/wrong-state/
    wrong-audience/swapped-nonce tests in Assay; rehearse rollback. Smoke as operator, member, invited email,
    agent-connect approval, and account deletion. Measure `/token` p95 at 50 RPS from multiple regions, and Safari/
    Chrome top-level redirect + `prompt=none` across identity/Assay/CI domains.
12. Keep Assay's old tables for at least a week after cut-over, and only then approve their drop migration.

## Google OAuth setup and rollout

1. In Google Cloud Console, create/select a project and configure the Google Auth Platform consent/branding,
   audience and test users as appropriate for that project's publication status.
2. Create an OAuth client of type **Web application**. Register this exact authorized redirect URI:
   `https://id.vibernt.ai/login/google/callback`. Use the authorization-code flow with `openid email` and PKCE S256;
   no browser Google SDK or external script is needed for this redirect-based flow.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secrets using the commands above. Keep both out of
   checked-in vars, SQL, logs and client app bundles. No secrets are set by the repository scripts.
4. Apply migration `0002_sign_in_methods.sql` through the normal D1 migration command. Back up first. It preserves
   existing clients' email/GitHub methods and live user identities, sessions, codes and access tokens while expanding
   the provider/method constraints. The local test applies it to populated SQLite and checks foreign keys and cascades;
   actual D1 migration remains a release check.
5. Seed/review each client's `sign_in_methods` and optional `google_hosted_domains` (CLIENTS.md). Google is not
   automatically added to existing clients. Domain restrictions use verified `hd`, independently of signup policy.
6. Before cut-over, test a real browser round trip, an invited new user, a verified existing email, a Google-only
   client rejecting email/GitHub, a mismatched Workspace domain, cancelled consent and replayed callback state.
   Check that the RP receives `amr=["google"]` and the original identity subject.

The server pins the token and JWKS endpoints from [Google's discovery metadata](https://accounts.google.com/.well-known/openid-configuration)
and validates locally against fetched/cached RSA keys. See [Google's OIDC setup and validation documentation](https://developers.google.com/identity/openid-connect/openid-connect).
No `tokeninfo` production validation, stale-key outage bypass or alternative-provider fallback is implemented.
The test suite proves the local protocol and failure paths with fake HTTP responses, not real Google consent,
Google credential acceptance, Cloudflare egress or Chrome/Safari cookie behavior.

## Keys, cleanup, queues and monitoring

Keys are WebCrypto P-256/ES256. AES-256-GCM seals private JWKs with fresh IVs and the kid as authenticated data.
Concurrent first use converges on a single stored generation. The every-minute scheduled handler creates the successor
one hour before a 90-day activation boundary; a delayed sweep waits a full hour before using the new key. A retired
key is published for 24 hours after the successor activates. JWKS HTTP max-age is five minutes and each Worker
isolate memoises the document for one minute; discovery and JWKS have no per-address rate limit. Client 0.3.0
refetches JWKS after 10 minutes, refreshes once on an unknown kid, and keeps verifying with keys up to 24 hours old
only while identity is unreachable. Never discard existing published keys during a deploy.

**Emergency key revocation** (`POST /admin/keys/<kid>/revoke`, ten-minute re-authentication) removes a key from
JWKS at once and creates a replacement that signs immediately. Tokens it signed stop verifying as apps refetch:
within about 10 minutes for client 0.3.0, sooner for an app that sees the replacement's unknown kid. Use it only
for a compromised key; scheduled rotation keeps the 24-hour overlap. A key that becomes unreadable (wrong
`SEALING_KEY`, corrupted row) is retired but stays verifiable for 24 hours; a D1 error never retires a key.

Missing/wrong sealing keys cause explicit failure; there is no automatic key replacement. Restore the correct secret.
M1 has one sealing secret, not Assay's general KEK ring. Do not simply overwrite it. A future sealing-secret change
requires an explicit offline reseal migration under both keys, a backup and a coordinated Worker secret update.
Automatic ES256 signing-key rotation is implemented; manual rotate-now belongs to the M4 control plane. Sealing-secret migration remains separate work.

The every-minute handler also removes expired links, OAuth states, requests, codes, access tokens, tombstones, sessions,
invitations and replay-budget rows. Audit has SQL UPDATE/DELETE rejection triggers; these prevent application
mutation, not an operator with DDL privileges. Audit contains event type, actor id and bounded metadata, never raw
sign-in tokens, provider credentials or email addresses.

**Retention** (migration `0008`): audit rows are kept 400 days. The delete trigger refuses any younger row, and the
sweep deletes older rows in batches of 5,000. Export the audit table before that if you need longer history.
Spent agent refresh tokens are kept 7 days (the reuse-detection window). Revoked or expired grants stay listed at
`/account` for 30 days, then they and their tokens are deleted. Delivered outbox rows are kept 30 days.

M2 produces and delivers agent revocation events through the logout Queue and a durable outbox (below). Human logout
messages remain unsupported and retry to DLQ; they are never acknowledged as delivered. Alert on DLQ growth.
Block/delete checks stop future identity authorization, code exchange and UserInfo; already issued JWTs/app sessions
are not remotely revoked in M1. Complete M4 block propagation and human back-channel logout before promising one-minute block propagation.

Monitor configuration errors, Turnstile/provider failures, neutral-email delivery failures, key-unavailable errors,
code_replay audit events, D1 latency and every-minute trigger success. Cloudflare rate bindings are per location, not a
strict global limiter; email/IP D1 budgets and Turnstile replay records provide separate persistent protections.
Automatic invocation logs are disabled to avoid recording OAuth callback query credentials; retain only controlled
application logs and audit events. Review any account-level Logpush/tracing separately.
No fallback to D1 for missing rate bindings, no challenge outage bypass, and no fake provider success exist.

## Rollback

Before import/deploy: back up D1 and the sealing secret. Preserve old Assay tables and the last working Worker version.
If cut-over fails, roll back **Assay's Worker version** to its prior own-auth implementation. Principal ids are
unchanged; old auth tables still exist. Users may need to sign in again. Do not drop the identity users/keys or
reimport over conflicting identities automatically. Rolling back the identity Worker should retain its compatible
D1 schema and signing ring. Rehearse both service availability and a full sign-in in the previous Assay version.

## Remaining release gates

- Verify the full sign-in and consent UI, including Turnstile CSP, in Chrome and Safari.
- Provision, validate Wrangler configuration in the actual Cloudflare account, deploy with zero clients, import,
  verify actual email delivery, GitHub OAuth and Google OIDC. No live account calls have been performed by this task.
- Qualify the implemented client package in Assay cut-over/negative tests; remove old Assay routes only in that release.
- Run OpenID conformance; the supported flows and unsupported OIDC optional features must be
  assessed by the chosen profile. No conformance pass is claimed.
- Prove latency, cross-domain cookie behavior, rollback and actual mail delivery. M4 console, block/merge/delete
  workflows, manual client management and human back-channel logout remain out of this server scope. M2 agent delivery still needs live qualification.

Provider contract references: [Workers Email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
[Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## M2 agent-access operations

Apply `0004_agent_access.sql` after the existing migrations through the reviewed deployment process. It adds app
settings with `agent_access='off'`, a separate public-agent registry, bounded metadata cache, grants, hashed code/
refresh/device credentials, and a revocation outbox. It preserves existing subjects, sign-in clients and sessions.
Enable one app only after reviewing its scope descriptions, exact resource prefixes, registration methods,
allowlist and grant cap (CLIENTS.md). Overlapping resource ownership is an error, not a longest-prefix guess.
No changes to Assay source, production D1, secrets, or deployed resources are part of this implementation.

Local M2 tests use the server handler and real SQLite, locally signed ES256 JWTs, the actual client package, and a
fixture MCP-style resource server. They cover challenge/discovery, metadata registration, app sign-in and consent,
resource calls, refresh/revoke, device approval/denial/expiry/slow_down, replay/concurrency, wrong workspace/PKCE/
redirect, current-policy enforcement, SSRF inputs, cache/timeout/size limits, and signed queue delivery with fake
transport. The vendored single-file package is compared with its modular sources and used to verify a server token.
`node scripts/build-client.mjs` only regenerates that optional artifact; the Worker and package need no build step.

Metadata fetching introduces one fixed dependency: `https://cloudflare-dns.com/dns-query`, then the agent's public
HTTPS document. Failures stop the request with `invalid_client_metadata`; there is no alternate resolver, cached
stale document, or automatic switch to dynamic registration. Both DNS address families are checked. Production
must run this path using Workers global fetch without private/VPC/service bindings. DNS preflight is not connection
pinning. Qualify private/link-local and DNS-rebinding denial in the actual Workers runtime before enabling agent
access; the Node test harness uses fake transport and cannot establish that deployed network property. See
[Cloudflare's binding and SSRF boundary discussion](https://blog.cloudflare.com/workers-environment-live-object-bindings/).
Do not port this fetcher to a general-purpose Node server without implementing and testing connection-pinned egress.

Metadata is cached in D1, not KV: at most 2,000 entries, five minutes to one hour of freshness, with no stale serving.
The every-minute sweep removes expired metadata/codes, device rows expired more than one day, and dynamic registrations
unused for 30 days. Grant, refresh-token and audit retention are described above. Last-used time means successful identity token issuance/refresh, not resource calls.

Agent revocation writes its audit record and any back-channel outbox record atomically with grant revocation.
It then sends pending events through the existing `LOGOUT_QUEUE` binding. Missing or failed queue transport can
return an error to the account request **after the grant has been revoked**; inspect the account and outbox rather
than restoring access. The every-minute sweep retries pending outbox records. An interrupted send may enqueue twice;
receivers must deduplicate the signed event `jti`. No network request runs inside a DB transaction.

The consumer implements only `type=agent_revocation`. It signs the dedicated event documented in PROTOCOL.md,
POSTs to the reviewed app back-channel URI, refuses redirects, and acknowledges only 2xx. Other messages still retry;
human OIDC back-channel logout is not implemented by M2. Delivery failures retry after 60 seconds and use the existing
queue retry/DLQ configuration. Re-drive a repaired DLQ message with its original event ID; the outbox row must remain
available. Monitor oldest unqueued event, retry/DLQ counts, failed scheduled sweeps, metadata fetch errors, and
`agent_refresh_reuse`. Tokens and device/user codes must not be included in request or application logs.

```sql
SELECT app_id,COUNT(*) FROM agent_grants WHERE revoked_at IS NULL AND expires_at>unixepoch()*1000 GROUP BY app_id;
SELECT COUNT(*),MIN(created) FROM agent_revocation_outbox WHERE queued_at IS NULL;
SELECT event,COUNT(*) FROM audit WHERE event IN ('agent_grant','agent_refresh','agent_revoke','agent_refresh_reuse') GROUP BY event;
```

Remaining M2 live checks: real Claude Code, Cursor and Codex against a local Assay MCP with only its address;
`cri login` against the device endpoint; Chrome/Safari human consent and account revocation; deployed D1 migration
and concurrent refresh; Workers DNS/SSRF/rebinding behavior; and real Queue-to-app receipt/retry/deduplication.
These have not been executed. Assay changes require separate authorization. The in-process resource fixture is
protocol evidence, not an Assay integration or an M2 live exit-gate pass. A revoked grant cannot refresh, but an
already issued JWT can remain usable for up to 60 seconds; do not promise immediate offline-token revocation.
