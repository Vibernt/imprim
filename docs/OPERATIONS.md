# Operations

How to run an Imprim deployment day to day: keys, retention, delivery, monitoring, backups, provider apps, release
gates and incidents. [Deploying](DEPLOY.md) covers first setup and upgrades; [Configuration](CONFIGURATION.md) lists
every binding and setting.

## Local checks

Use Node 22.13 or later (the tests use `node:sqlite`). There is nothing to install.

```bash
npm run test:quiet
```

```bash
npm run check
```

The suite runs the Worker's request handler against real in-memory SQLite behind a D1-shaped harness, with fake
email, rate-limit, queue and provider responses (including locally signed Google ID tokens and fake JWKS
endpoints). It opens no listener and sends no email. `check` validates ESM syntax and that there are no runtime
packages or imports. Passing both does not prove native browser cookie behaviour, real mail delivery, Cloudflare
rate limits, Worker egress, Queue delivery or OpenID conformance: those are [release gates](#release-gates).

## Keys and rotation

Each realm has two rings of signing keys: ES256 (P-256), which signs everything by default, and RS256 (RSA 2048), which
signs the ID and logout tokens of apps that choose it. Both rotate on the same schedule and share one JWKS. Private JWKs are sealed with AES-256-GCM under
`SEALING_KEY`, with a fresh IV and the `kid` as authenticated data. JWKS publishes public keys only.

- **Scheduled rotation.** The every-minute handler publishes a successor one hour before the current key's 90-day
  activation boundary. The old key stays in JWKS for 24 hours after the successor starts signing. Never delete
  published keys during a deploy.
- **Caching.** JWKS is served with a five-minute HTTP max-age and memoised per isolate for one minute. Discovery
  and JWKS have no per-address rate limit. `imprim-client` 0.3.0 and later refetch JWKS after 10 minutes, refresh
  once on an unknown `kid`, and keep verifying with keys up to 24 hours old only while the issuer is unreachable.
- **Rotate now.** A platform admin can rotate from the console (Keys) or `POST /admin/api/keys/rotate`. The new key
  is public at once and signs one hour later. A second rotation is refused while one is pending.
- **Emergency revocation.** `POST /admin/api/keys/<kid>/revoke` removes a key from JWKS at once and creates a
  replacement that signs immediately. Tokens it signed stop verifying as apps refetch: within about 10 minutes for
  client 0.3.0, sooner for an app that meets the replacement's unknown `kid`. Use it only for a compromised key.
- **Unreadable keys.** Only proven corruption (an AES-GCM failure, an unreadable envelope or a public-key mismatch)
  retires a key. Imprim audits and logs `oidc_key_unreadable`, keeps an unreadable active key verifiable for
  24 hours, and creates a new generation. A D1 error never retires a key. Treat the event as an
  [incident](#incidents).
- **`SEALING_KEY`.** 32 random bytes as 64 hex characters, one for the whole deployment. Keep an offline copy apart
  from database backups. A missing or wrong key fails explicitly; nothing replaces keys automatically. Changing it
  needs an offline reseal of every sealed value (signing keys and TOTP secrets) under both keys, a backup and a
  coordinated secret update. Imprim has no tool for that yet.

## Retention and the scheduled handler

The cron trigger (`* * * * *`) dispatches pending back-channel events, runs each realm's key sweep and deletes
expired state:

| What | Kept |
|---|---|
| Email links, upstream OAuth states, pending requests, codes, UserInfo tokens, sessions, invitations, rate-limit rows, passkey challenges, pending email changes, DPoP and assertion replay records | Until their own expiry |
| Expired device codes | One more day, so polling agents get `expired_token` |
| Dynamic agent registrations | 30 days after last use |
| Spent agent refresh tokens | 7 days (the reuse-detection window) |
| Revoked or expired agent grants | 30 days, still listed at `/account/agents`, then deleted with their tokens |
| Delivered outbox rows | 30 days, at most 500 rows per outbox per run |
| App-session associations | 30 days after creation, at most 500 per run |
| Unconfirmed authenticator enrolments | One hour |
| Audit | 400 days; the delete trigger refuses younger rows, and the sweep deletes older ones 5,000 at a time |

Export the audit log before 400 days if you need longer history: `GET /admin/api/audit/export?after=<id>` returns
NDJSON, oldest first, 1,000 rows a page, with `x-next-after` while more remain. Audit triggers stop the application
from changing rows; they do not stop an operator with DDL rights.

## Queues, outboxes and the dead-letter queue

Back-channel logout, agent revocation and user events are written to durable outboxes (`logout_outbox`,
`agent_revocation_outbox`, `user_event_outbox`) in the same D1 batch as the change that causes them. No network call
runs inside that batch.

1. The request that caused the event queues it on `LOGOUT_QUEUE` after responding (`waitUntil`). A queue failure is
   logged as `event_queue_deferred` and left for the cron.
2. Every minute, the dispatcher re-queues any undelivered row not queued in the last minute, 100 at a time through
   the whole backlog.
3. The consumer signs the event at delivery and POSTs it to the app's **current** `backchannel_uri` with a
   10-second deadline and no redirects. Only a 2xx marks it delivered. A failure records `last_error` and retries
   after 10 seconds; after 5 retries the message goes to the dead-letter queue.
4. 24 hours after creation an undelivered event becomes `expired`, is audited as `backchannel_expired`, and is never
   signed or sent.

A message in the dead-letter queue does not lose the event: the outbox row stays pending and the cron re-queues it
until delivery or expiry. Use the dead-letter queue to see that an app is failing, then fix the app or its
`backchannel_uri`. An app with no `backchannel_uri` shows as `missing_uri` and its events stay pending. Delivery is
at least once, so apps must deduplicate the event `jti`.

The console's Settings page shows pending counts, the oldest pending event and apps with no destination. Each
client page shows its undelivered and expired events with their last error.

## Monitoring and logs

`observability` is on with **invocation logs off**, because OAuth callback URLs carry codes and state in the query.
Application logs are structured JSON with a type, path and error code, never tokens, codes, links, secrets or
email addresses. Review any account-level Logpush or tracing separately, and check your log retention.

Watch for:

| Signal | Where | Meaning |
|---|---|---|
| `request_failed` | Logs | An unexpected 500 |
| `oidc_key_unreadable` | Logs and audit | A sealed key could not be opened ([incident](#incidents)) |
| `turnstile_unavailable`, `turnstile_degraded` | Logs and audit | Siteverify is down; email links go to existing active users only |
| `magic_delivery_failed`, `notice_failed` | Logs and audit | Email sending is failing |
| `event_queue_deferred` | Logs | The queue refused a send; the cron will retry |
| `code_replay`, `agent_code_replay`, `agent_refresh_reuse` | Audit | A code or refresh token was used twice |
| `backchannel_expired` | Audit | An app missed an event for 24 hours |
| Dead-letter queue depth, cron failures, D1 latency | Cloudflare dashboard | Delivery or maintenance trouble |

Cloudflare rate-limit bindings count per location, not globally. The D1 budgets (per recipient, per address and
for agent actions) are separate and persistent. A missing rate binding fails the request; there is no fallback.

Useful queries, run with `wrangler d1 execute <database> --remote --env <env> --command "<sql>"`:

```sql
SELECT realm_id, status, COUNT(*) FROM users GROUP BY realm_id, status;
SELECT COUNT(*), MIN(created) FROM logout_outbox WHERE delivered_at IS NULL AND delivery_state != 'expired';
SELECT COUNT(*), MIN(created) FROM agent_revocation_outbox WHERE delivered_at IS NULL AND delivery_state != 'expired';
SELECT app_id, COUNT(*) FROM agent_grants WHERE revoked_at IS NULL AND expires_at > unixepoch() * 1000 GROUP BY app_id;
SELECT event, COUNT(*) FROM audit WHERE created > (unixepoch() - 86400) * 1000 GROUP BY event ORDER BY 2 DESC;
```

## Backups and restore

Back up before every migration and every import:

```bash
wrangler d1 export <database> --remote --env production --output backup.sql
```

Keep `SEALING_KEY` backed up separately: a database backup without it cannot sign anything or read TOTP secrets.

`wrangler rollback --env production` returns the Worker to its previous version. Migrations are not rolled back.
Restore a backup only if a migration itself is wrong, and treat that as an incident: a restore loses every session,
grant and audit row written since the backup.

## Provider apps, per realm

Each realm registers its own app with each provider, so the consent screen shows that brand. Put the client id in
the realm's `providers` config and each secret in a Worker secret named by `{"env": "NAME"}` ([Realms](REALMS.md)).
A provider is offered only to apps that list its id in `sign_in_methods`; a missing credential fails explicitly.

| Provider | Register | Callback URL |
|---|---|---|
| GitHub | An OAuth app. Imprim asks for `read:user user:email` and uses PKCE. GitHub shows the client secret once. | `<issuer>/auth/github/callback` |
| Google | A Google Auth Platform OAuth client of type Web application. Imprim asks for `openid email` and uses PKCE. While the app is in Testing, only listed test users can sign in. | `<issuer>/login/google/callback` |
| Microsoft | An app registration (Microsoft Entra ID) with a Web redirect URI and a client secret. Set `tenant` to `common`, `organizations`, `consumers` or a tenant id. | `<issuer>/login/provider/<id>/callback` |
| Apple | A Services ID (the `client_id`) with Sign in with Apple, and a key: `team_id` and `key_id` in config, the PKCS#8 PEM in the secret that `private_key` names. Apple posts the callback (`form_post`). | `<issuer>/login/provider/<id>/callback` |
| Any OIDC issuer | A confidential client for the authorization code flow. `issuer` must equal the discovery document's `issuer`. Scopes default to `openid email profile`; `token_auth` is `client_secret_basic` (default) or `client_secret_post`. | `<issuer>/login/provider/<id>/callback` |
| Turnstile | A widget listing the realm's hostname. Imprim checks the action `sign_in` and the hostname. | None |
| Email | Cloudflare Email sending enabled for the sender's domain. | None |

`<issuer>` is the realm's issuer origin, such as `https://id.example.com`, and `<id>` is the provider's key in
`providers`. Imprim pins Google's endpoints from its discovery metadata, accepts only RS256 Google ID tokens and
never stores provider access tokens. A provider's email links an existing account or satisfies `allowed_domains`
only when its domain is in that provider's `trusted_domains` (with a pinned tenant for Microsoft), or for Google with
a signed `hd`.

Turnstile: with both keys absent, email sign-in runs without a challenge (for development). With one key, requests
fail with `turnstile_config`. Do not use Cloudflare's dummy test keys on a real issuer.

## Agent metadata egress

Fetching an agent's client ID metadata document or `jwks_uri` has one fixed dependency: Cloudflare DNS over HTTPS
(`https://cloudflare-dns.com/dns-query`), then the document itself over Workers global fetch. Both A and AAAA answers
must be public addresses. A failure stops the request with `invalid_client_metadata`, with no other resolver, no
stale copy and no switch to dynamic registration. DNS checking is not connection pinning, so qualify private-address
and DNS-rebinding refusal on your own deployment before turning agent access on. Do not run this fetcher on a
general-purpose server without connection-pinned egress.

## Importing existing users

When an app moves to Imprim, import its users so each keeps their id as `sub`:

1. Export users and provider identities to JSON, outside Git. The shape is documented at the top of
   `scripts/import-users.mjs`.
2. Generate SQL for a realm. The script validates the whole file before printing anything and makes no network
   calls:

   ```bash
   node scripts/import-users.mjs export.json default > import.sql
   ```

3. Back up D1, review the SQL, then apply it:

   ```bash
   wrangler d1 execute <database> --remote --env production --file import.sql
   ```

   D1 does not apply a large file as one transaction. On a conflict, stop, resolve it deliberately and rerun. A
   rerun keeps ids and never reactivates a blocked or deleted user or relinks a provider id.
4. Check counts and duplicates:

   ```sql
   SELECT status, COUNT(*) FROM users GROUP BY status;
   SELECT lower(email), COUNT(*) FROM users GROUP BY realm_id, lower(email) HAVING COUNT(*) > 1;
   SELECT i.provider_id FROM user_identities i LEFT JOIN users u ON u.id = i.user_id WHERE u.id IS NULL;
   ```

Keep the app's old authentication tables until the switch has run cleanly for at least a week.

## Release gates

Before a release reaches people, on staging:

- `npm run check` and `npm run test:quiet` pass on the release commit.
- Each sign-in method an app enables works end to end in Chrome and Safari, including Turnstile and the CSP.
- Real email reaches Gmail, Outlook and iCloud inboxes.
- An agent connects by code flow and by device code; a revocation reaches the app's back-channel URI; an admin
  block ends the app session.
- Agent metadata fetches refuse private addresses and DNS rebinding from the deployed Worker.
- `/token` latency is acceptable from the regions your apps run in.
- The OpenID conformance basic profile passes against staging. Imprim claims no conformance result yet.

[Security](SECURITY.md#not-yet-verified-live) lists what has not been verified on a live deployment.

## Incidents

- **A signing key may be exposed.** Revoke it (`POST /admin/api/keys/<kid>/revoke`), confirm the new `kid` in JWKS,
  and ask app owners to confirm they refetched. Review `token_issued` and `agent_token` audit rows for the period.
- **`oidc_key_unreadable`.** Check that `SEALING_KEY` is the expected secret on this environment. Do not change the
  sealing key to clear it. Confirm sign-in and JWKS work before continuing a rollout.
- **Code replay or refresh reuse.** The access token or grant is already revoked. Find the client and person in
  audit, and contact the app or agent author if it repeats.
- **An account is taken over.** Block the user in the console (this ends sessions, revokes grants and notifies
  apps), then reset their second factor (`reset-mfa`, with a reason) before unblocking.
- **Turnstile or email is down.** Turnstile degrades to existing active users only, under tighter limits; new
  sign-ups wait. Email failures are audited; the public answer stays neutral.
- **Back-channel events are piling up.** Check Settings for apps without a destination and the client page for the
  last error. Events expire after 24 hours, so fix the receiver within that window.
- **A migration went wrong.** Roll back the Worker, then restore the pre-migration backup. Anything written since
  is lost.

Report a vulnerability in Imprim itself privately ([SECURITY.md](https://github.com/Vibernt/imprim/blob/main/SECURITY.md)).
