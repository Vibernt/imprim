# Configuration

`apps/server/wrangler.jsonc` declares the Worker environment. Operators set deployment IDs and secrets after review. The repository has placeholder D1/KV IDs, no active custom-domain route, `workers_dev:false` and `preview_urls:false`. See [Operations](OPERATIONS.md) before deployment. No setting below is a browser secret unless marked public.

## Worker values and bindings

| Name | Kind and checked-in default | Set by and when |
|---|---|---|
| Realms | D1 table `realms` | Issuer host, display name and config per brand ([Realms](REALMS.md)). Set with `scripts/realm.mjs` or the platform console. |
| Admins | D1 table `admins` | Per-realm roster (`platform` or `realm`). Never a committed variable. |
| `EMAIL_FROM` | Var, production env only: `signin@vibernt.ai` (read by the default realm's config) | vibernt.ai is enabled and configured in Cloudflare Email Sending (shared with Assay's `ci@vibernt.ai`). |
| `TURNSTILE_SITE_KEY` | Public var: `0x4AAAAAAF0OXQdsR3N-CAwj` (widget `vibernt-identity`, hostname `id.vibernt.ai`) | Operator; its secret is `TURNSTILE_SECRET`. Tests use their own fake keys. |
| `SEALING_KEY` | Secret: absent; 64 hex characters | Operator sets before key creation; back up separately. |
| `GITHUB_CLIENT_ID` | Secret: absent | Operator sets before enabling GitHub. |
| `GITHUB_CLIENT_SECRET` | Secret: absent | Operator sets with GitHub client ID. |
| `GOOGLE_CLIENT_ID` | Secret: absent | Operator sets before enabling Google. |
| `GOOGLE_CLIENT_SECRET` | Secret: absent | Operator sets with Google client ID. |
| `TURNSTILE_SECRET` | Secret: absent | Operator sets with site key. Both absent disable challenge for local/development; partial config fails. |
| `DB` | D1 `vibernt-identity`; database ID placeholder | Operator provisions and replaces ID before migration/deploy. |
| `EMAIL` | Cloudflare `send_email` binding | Operator provisions and verifies delivery before live sign-in. |
| `AUTH_LIMITER` | Rate binding namespace `5101`, 20/60 seconds | Operator reviews namespace and config before deploy. Missing binding fails. |
| `API_LIMITER` | Rate binding namespace `5102`, 120/60 seconds | Operator reviews namespace and config before deploy. Missing binding fails. |
| `LOGOUT_QUEUE` | Producer for `vibernt-identity-logout` | Operator provisions before agent revocation delivery. |
| Queue consumer | Same queue, three retries, `vibernt-identity-logout-dlq` | Operator provisions DLQ and tests receipt/retry. |
| Cron | `* * * * *` | Checked-in every-minute schedule; operator verifies live triggers. |
| Custom-domain route | Commented out | Operator enables for reviewed production deploy. |
| Observability | Enabled; invocation logs disabled | Operator reviews log retention and redaction at deployment. |

GitHub callback is `/auth/github/callback`; Google callback is `/login/google/callback`. Neither upstream credential is needed for a client that does not enable that method. `SEALING_KEY` is not a signing-key rotation toggle; replacing it requires a migration of sealed keys.

## App client row (`clients`)

A trusted operator inserts or updates a row after review. `scripts/seed-client.mjs` validates a JSON file and prints insert SQL; it never writes D1. Every app setting is below. JSON column defaults are shown as decoded values.

| Setting | Default | Who sets it and when |
|---|---|---|
| `id` | Required, unique | Operator chooses stable app client ID at registration. |
| `secret_hash` | Required in seed: SHA-256 hex or explicit `null` | Operator stores hash; app stores plaintext secret. `null` is public PKCE client. |
| `redirect_uris` | Required nonempty list | App owner and operator review exact callback URLs before registration. |
| `post_logout_uris` | `[]` | App owner and operator review exact return URLs before use. |
| `backchannel_uri` | `null` | App owner and operator review HTTPS receiver before agent revocation delivery. Human logout sending is pending. |
| `signup_policy` | `invited` | Operator chooses `invited` or `open` before accepting new people. |
| `allowed_domains` | `[]` | Operator sets exact email domains for invited admission. |
| `branding` | `{}` | Operator or app owner sets name, theme, copy, links and logo ids over the realm's ([Branding](BRANDING.md)); validated and contrast-checked on save. |
| `dev` | `0` | Operator sets `1` only for clients requiring exact HTTP loopback redirects. |
| `sign_in_methods` | SQL migration default `["email","github"]`; seed requires explicit list | Operator sets ordered enabled methods per app. |
| `google_hosted_domains` | `[]` | Operator sets signed Google `hd` restrictions if needed. |
| `agent_access` | `off` | Operator enables only after resource and scope review. |
| `agent_registration_methods` | `["metadata_document"]` | Operator may also allow `dynamic`. |
| `agent_allowlist` | `[]` | Operator optionally restricts agent client ID URLs or hosts. |
| `agent_scope_catalogue` | `{}` | App owner defines scope descriptions; required when access is on. |
| `agent_resource_prefixes` | `[]` | App owner and operator register canonical HTTPS ownership; required when on. |
| `agent_max_grant_days` | `90` | Operator caps consent duration in positive whole days. |

The seed script requires explicit `sign_in_methods`, `redirect_uris` and `secret_hash`. It validates known keys, URI shape, methods, domains, branding and agent settings. Existing rows are not overwritten by its insert. Changing a row is a reviewed policy edit. An app secret rotation changes both the app secret and stored hash together; there is no overlapping-secret grace period.

## Runtime limits

D1 `rate_limits` adds email/IP, degraded Turnstile and agent action budgets. These are code constants, not Wrangler vars. Agent metadata is cached in D1, not `CONFIG_CACHE`. See [Architecture](ARCHITECTURE.md) for budgets and [Security](SECURITY.md) for the failure mode of missing dependencies.
